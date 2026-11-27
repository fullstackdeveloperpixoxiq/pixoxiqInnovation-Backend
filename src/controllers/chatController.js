import crypto from 'crypto';
import mongoose from 'mongoose';
import ChatConversation from '../models/ChatConversation.js';
import ChatMessage from '../models/ChatMessage.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import { sha256 } from '../ai/crypto.js';
import { getChatClient, getConfigSummary, hitTokenLimit, TOKEN_LIMIT_HINT } from '../ai/configService.js';
import {
  generateReply,
  getChatSettings,
  loadHistory,
  sanitizeUserMessage,
  updateSummaryIfNeeded,
} from '../ai/chatService.js';
import { logAi } from '../ai/logger.js';
import {
  buildQuotaPlan,
  carryOverAnonymousUsage,
  getQuotaUsage,
  recordAnswer,
  refundQuestion,
  reserveQuestion,
  secondsUntilReset,
} from '../ai/quotaService.js';
import { classifyIntent, INTENTS } from '../ai/intentService.js';
import { confirmEmailOtp, EMAIL_RE as VERIFY_EMAIL_RE, requestEmailOtp, resolveChatAccess, revokeEmailVerification } from '../ai/chatAccess.js';
import { deleteEnquiriesFor, recordEnquiry } from '../ai/enquiryService.js';
import { candidateInstructions, collectCandidateDetails } from '../ai/candidateService.js';
import { markEnquiryChanged } from '../services/recruitmentSync.js';

// Public endpoints of the Pixpi AI used by the website.
// Visitors are anonymous: POST /session issues a random token which the browser sends in
// the X-Chat-Session header. Only its SHA-256 hash is stored, and every conversation
// query is scoped to that hash, so visitors can only ever access their own conversations.

const SESSION_HEADER = 'x-chat-session';
const TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/;

export const requireVisitor = (req, res, next) => {
  const token = req.get(SESSION_HEADER);
  if (!token || !TOKEN_RE.test(token)) return next(ApiError.unauthorized('Chat session missing or invalid'));
  req.visitorHash = sha256(token);
  next();
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// Records who is asking (logged-in account and/or the email entered in the chat) for admins
const identify = (req, conversation) => {
  if (req.user && !conversation.user) conversation.user = req.user._id;
  const email = String(req.get('x-chat-email') || req.user?.email || '').trim().toLowerCase().slice(0, 254);
  if (email && EMAIL_RE.test(email) && !conversation.visitorEmail) conversation.visitorEmail = email;
};

const toPublicMessage = (m) => ({
  id: String(m._id || m.id),
  role: m.role,
  content: m.content,
  sources: (m.sources || []).map((s) => ({ title: s.title, category: s.category, live: !s.entry })),
  interrupted: Boolean(m.interrupted),
  ...(m.awaitingVerification ? { awaitingVerification: true } : {}),
  createdAt: m.createdAt,
});

const toPublicConversation = (c) => ({
  id: String(c._id || c.id),
  title: c.title,
  messageCount: c.messageCount,
  lastMessageAt: c.lastMessageAt,
  createdAt: c.createdAt,
});

const findOwnConversation = async (id, visitorHash) => {
  if (!mongoose.isValidObjectId(id)) throw ApiError.notFound('Conversation not found');
  const conversation = await ChatConversation.findOne({ _id: id, visitorHash });
  if (!conversation) throw ApiError.notFound('Conversation not found');
  return conversation;
};

// Avoid flooding the log when a misconfigured assistant gets traffic
let lastConfigLog = 0;
const ensureAvailable = async () => {
  const settings = await getChatSettings();
  if (!settings.enabled) throw new ApiError(503, 'The PIXOXIQ assistant is currently unavailable.');
  try {
    await getChatClient();
  } catch (err) {
    if (Date.now() - lastConfigLog > 5 * 60 * 1000) {
      lastConfigLog = Date.now();
      await logAi({ source: 'config', message: `Chat request rejected: ${err.message}`, code: err.code });
    }
    throw new ApiError(503, 'The PIXOXIQ assistant is not configured yet. Please use the contact form to reach our team.');
  }
  return settings;
};

// ---------- Daily question quota ----------
// Every question (new message or regenerated answer) reserves one unit of the daily quota
// before the AI provider is called; see ai/quotaService.js.

const quotaExceededMessage = (plan, blockedBy, settings) => {
  if (plan.authenticated) {
    return `You have used all ${plan.limit} questions for today. Your quota resets at midnight IST.`;
  }
  const upgrade = `Log in or create a free account to get ${settings.userDailyQuestionLimit} questions per day.`;
  if (blockedBy === 'ip') return `The daily limit for visitor questions from your network has been reached. ${upgrade}`;
  return `You have used all ${plan.limit} free questions for today. ${upgrade} Your quota resets at midnight IST.`;
};

// HTTP 429 with the current usage, so the website can show it and disable the input
const sendQuotaExceeded = (res, plan, result, settings) => {
  res.set('Retry-After', String(secondsUntilReset(plan)));
  res.status(429).json({
    success: false,
    code: 'quota_exceeded',
    message: quotaExceededMessage(plan, result.blockedBy, settings),
    usage: result.usage,
  });
};

const publicErrorMessage = (err) => {
  if (err.code === 'rate_limited') return 'The assistant is receiving a lot of requests right now. Please try again in a moment.';
  if (err.code === 'timeout') return 'The assistant took too long to respond. Please try again.';
  return 'The assistant could not answer right now. Please try again later.';
};

// Generates the assistant reply and streams it as Server-Sent Events (or JSON with ?stream=0).
// Events: meta, sources, delta, done, error.
// `replaces`: the previous answer being regenerated. It is only deleted once the new answer
// has been stored, so a failed regeneration never loses the existing answer.
// `intent`/`access` (from the classifier and resolveChatAccess) decide whether recruitment
// data may be used; an AMBIGUOUS intent is answered with its clarifying question instead of
// calling the answering model.
const respond = async (
  req,
  res,
  { conversation, history, message, visitorHash, reservation, usage, intent, access, extraInstructions = '', regenerated = false, replaces = null }
) => {
  const streaming = req.query.stream !== '0';
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });

  let send = () => {};
  let heartbeat;
  if (streaming) {
    res.status(200).set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    send = (event, data) => {
      if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    heartbeat = setInterval(() => !res.writableEnded && res.write(': ping\n\n'), 15000);
    send('meta', { conversation: toPublicConversation(conversation) });
    // The question has been accepted and counted
    send('usage', usage);
    send('intent', publicIntent(intent, access));
  }

  let partial = '';
  let sources = [];
  try {
    const clarify = intent?.category === INTENTS.AMBIGUOUS;
    if (clarify) send('delta', { text: intent.clarification });
    const result = clarify
      ? { text: intent.clarification, sources: [], usage: intent.usage, provider: 'classifier', model: '', finishReason: 'clarification' }
      : await generateReply({
      history,
      message,
      summary: conversation.summary,
      allowRecruitment: Boolean(access),
      jobIntent: intent?.category === INTENTS.JOB,
      extraInstructions,
      signal: controller.signal,
      onSources: (s) => {
        sources = s;
        send('sources', s.map((x) => ({ title: x.title, category: x.category, live: !x.entry })));
      },
      onDelta: streaming
        ? (text) => {
            partial += text;
            send('delta', { text });
          }
        : undefined,
    });

    let content = result.text;
    if (!content.trim()) {
      await logAi({
        level: 'warn',
        source: 'chat',
        message: `The model returned an empty answer (finish reason: ${result.finishReason || 'unknown'})${
          hitTokenLimit(result.finishReason) ? `. ${TOKEN_LIMIT_HINT}` : ''
        }`,
        provider: result.provider,
        model: result.model,
        context: { conversationId: String(conversation._id) },
      });
      content = "I'm sorry, I couldn't produce an answer to that. Could you rephrase your question?";
      send('delta', { text: content });
    }

    await recordAnswer(reservation, result.usage);
    const assistant = await ChatMessage.create({
      conversation: conversation._id,
      visitorHash,
      role: 'assistant',
      content,
      sources: result.sources,
      provider: result.provider,
      model: result.model,
      usage: result.usage || undefined,
      latencyMs: result.latencyMs,
      finishReason: result.finishReason || undefined,
      regenerated,
    });
    if (replaces) await replaces.deleteOne();

    if (!replaces) conversation.messageCount += 1;
    conversation.lastMessageAt = new Date();
    conversation.totalInputTokens += result.usage?.inputTokens || 0;
    conversation.totalOutputTokens += result.usage?.outputTokens || 0;
    await conversation.save();

    if (streaming) {
      send('done', { message: toPublicMessage(assistant), conversation: toPublicConversation(conversation), usage });
      res.end();
    } else {
      res.json({
        success: true,
        answer: content,
        usage,
        intent: publicIntent(intent, access),
        data: { message: toPublicMessage(assistant), conversation: toPublicConversation(conversation), usage },
      });
    }

    updateSummaryIfNeeded(conversation._id);
  } catch (err) {
    const clientGone = controller.signal.aborted && err.code === 'aborted';
    if (clientGone) {
      // Visitor pressed stop / closed the page: the provider was already working on the
      // question, so it stays counted. Keep what was already shown.
      await recordAnswer(reservation, null).catch(() => {});
      if (partial.trim()) {
        await ChatMessage.create({
          conversation: conversation._id,
          visitorHash,
          role: 'assistant',
          content: partial,
          sources,
          interrupted: true,
          regenerated,
        }).catch(() => {});
        if (replaces) await replaces.deleteOne().catch(() => {});
        else conversation.messageCount += 1;
        conversation.lastMessageAt = new Date();
        await conversation.save().catch(() => {});
      }
      return;
    }

    await logAi({
      source: err.stage === 'retrieval' ? 'retrieval' : 'chat',
      message: `${err.stage === 'retrieval' ? 'Knowledge retrieval' : 'Answer generation'} failed: ${err.message}`,
      code: err.code,
      provider: err.client?.provider,
      model: err.client?.model,
      providerStatus: err.providerStatus,
      context: { conversationId: String(conversation._id) },
      secrets: err.client?.secrets,
    });

    // Server/provider failure: the question does not count
    await refundQuestion(reservation, { failed: true }).catch(() => {});
    const refunded = await getQuotaUsage(reservation.plan).catch(() => usage);

    if (streaming) {
      send('error', { message: publicErrorMessage(err), conversation: toPublicConversation(conversation), usage: refunded });
      res.end();
    } else if (!res.headersSent) {
      res.status(err.code === 'rate_limited' ? 429 : 503).json({
        success: false,
        code: err.code === 'rate_limited' ? 'provider_busy' : 'ai_unavailable',
        message: publicErrorMessage(err),
        usage: refunded,
      });
    }
  } finally {
    clearInterval(heartbeat);
  }
};

// ---------- Handlers ----------

export const getStatus = asyncHandler(async (req, res) => {
  const [settings, summary] = await Promise.all([getChatSettings(), getConfigSummary()]);
  res.set('Cache-Control', 'no-store');
  res.json({
    success: true,
    data: {
      enabled: Boolean(settings.enabled && summary.chat.configured),
      assistantName: settings.assistantName,
      welcomeMessage: settings.welcomeMessage,
      suggestedQuestions: settings.suggestedQuestions,
      maxMessageLength: settings.maxMessageLength,
    },
  });
});

// Daily question usage of this visitor / logged-in user (read-only for the browser)
export const getUsage = asyncHandler(async (req, res) => {
  const plan = buildQuotaPlan(req, await getChatSettings());
  await carryOverAnonymousUsage(plan);
  res.set('Cache-Control', 'no-store');
  res.json({ success: true, data: await getQuotaUsage(plan) });
});

export const createSession = asyncHandler(async (req, res) => {
  res.status(201).json({ success: true, data: { token: crypto.randomBytes(32).toString('base64url') } });
});

export const listConversations = asyncHandler(async (req, res) => {
  const items = await ChatConversation.find({ visitorHash: req.visitorHash })
    .sort({ lastMessageAt: -1 })
    .limit(50)
    .lean();
  res.json({ success: true, data: items.map(toPublicConversation) });
});

export const getConversation = asyncHandler(async (req, res) => {
  const conversation = await findOwnConversation(req.params.id, req.visitorHash);
  const messages = await ChatMessage.find({ conversation: conversation._id }).sort({ createdAt: 1, _id: 1 }).limit(500).lean();
  res.json({ success: true, data: { conversation: toPublicConversation(conversation), messages: messages.map(toPublicMessage) } });
});

export const deleteConversation = asyncHandler(async (req, res) => {
  const conversation = await findOwnConversation(req.params.id, req.visitorHash);
  await ChatMessage.deleteMany({ conversation: conversation._id });
  await deleteEnquiriesFor(conversation._id);
  await conversation.deleteOne();
  res.json({ success: true, message: 'Conversation deleted', data: { id: String(conversation._id) } });
});

// ---------- Job enquiry access: login or email verification ----------

const accessData = (access) => ({ verified: Boolean(access), method: access?.method || null, email: access?.email || null });

export const getVerification = asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ success: true, data: accessData(await resolveChatAccess(req)) });
});

const readEmail = (req) => {
  const email = String(req.body?.email || '').trim().toLowerCase().slice(0, 254);
  if (!VERIFY_EMAIL_RE.test(email)) throw ApiError.badRequest('Enter a valid email address');
  return email;
};

export const requestVerification = asyncHandler(async (req, res) => {
  if (req.user) throw ApiError.badRequest('You are already logged in.');
  const data = await requestEmailOtp({ visitorHash: req.visitorHash, email: readEmail(req) });
  res.status(202).json({ success: true, message: `We sent a 6-digit code to ${data.email}.`, data });
});

export const confirmVerification = asyncHandler(async (req, res) => {
  const email = readEmail(req);
  const otp = typeof req.body?.otp === 'string' || typeof req.body?.otp === 'number' ? String(req.body.otp).trim() : '';
  if (!/^\d{6}$/.test(otp)) throw ApiError.badRequest('Enter the 6-digit code');
  const access = await confirmEmailOtp({ visitorHash: req.visitorHash, email, otp });
  res.json({ success: true, message: 'Email verified', data: accessData(access) });
});

export const revokeVerification = asyncHandler(async (req, res) => {
  await revokeEmailVerification(req.visitorHash);
  res.json({ success: true, data: accessData(await resolveChatAccess(req)) });
});

// ---------- Intent classification + job enquiry access ----------

export const VERIFICATION_PROMPT = 'To help you with career-related questions, please log in or verify your email address.';

// What the browser is told about the classification (never trusted back from it)
const publicIntent = (intent, access) =>
  intent
    ? {
        category: intent.category,
        confidence: Math.round((intent.confidence || 0) * 100) / 100,
        verified: Boolean(access),
        method: access?.method || null,
      }
    : null;

/**
 * Classifies the question on the server and enforces the job-enquiry rule. Runs on every
 * message and regeneration, so access is re-checked on each request.
 * @returns {Promise<{ intent, access } | null>} null when a 403 was sent (question refunded)
 */
const classifyAndAuthorize = async (req, res, { conversation, history, message, userMessage, quota }) => {
  const [access, intent] = await Promise.all([
    resolveChatAccess(req),
    classifyIntent({ history, message, previous: conversation.category }),
  ]);

  userMessage.intent = intent.category;
  userMessage.intentConfidence = intent.confidence;
  if (intent.topic) userMessage.topic = intent.topic;
  // Admin section: a recruitment intent moves the whole conversation (history included) to
  // Job Queries; general topics keep it in Normal / General Queries
  if (intent.category === INTENTS.JOB) conversation.queryType = 'job';
  else if (intent.category === INTENTS.WEBSITE && conversation.queryType !== 'job') conversation.topic = intent.topic || 'other';
  conversation.category = intent.category;
  conversation.categoryConfidence = intent.confidence;
  conversation.classifiedAt = new Date();
  if (access?.method === 'email' && !conversation.verifiedEmail) conversation.verifiedEmail = access.email;

  if (intent.category === INTENTS.JOB && !access) {
    // Not answered: the question is given back and kept, so the same conversation can
    // continue (regenerate) right after the visitor logs in or verifies their email
    userMessage.awaitingVerification = true;
    await Promise.all([userMessage.save(), conversation.save()]);
    await refundQuestion(quota.reservation);
    const usage = await getQuotaUsage(quota.reservation.plan);
    res.status(403).json({
      success: false,
      code: 'verification_required',
      message: VERIFICATION_PROMPT,
      conversation: toPublicConversation(conversation),
      intent: publicIntent(intent, access),
      usage,
    });
    return null;
  }

  userMessage.awaitingVerification = undefined;
  await Promise.all([userMessage.save(), conversation.save()]);
  let extraInstructions = '';
  if (intent.category !== INTENTS.AMBIGUOUS) {
    try {
      const enquiry = await recordEnquiry({ conversation, intent, access, question: message });
      // Job enquiries: collect candidate details from the conversation, one step at a time
      if (enquiry?.type === 'job') {
        const userMessages = [...history.filter((m) => m.role === 'user').map((m) => m.content), message];
        if (await collectCandidateDetails({ enquiry, userMessages })) {
          markEnquiryChanged(enquiry);
          await enquiry.save();
        }
        extraInstructions = candidateInstructions(enquiry);
      }
    } catch (err) {
      await logAi({ source: 'chat', message: `Could not save the enquiry record: ${err.message}`, context: { conversationId: String(conversation._id) } });
    }
  }
  return { intent, access, extraInstructions };
};

export const sendMessage = asyncHandler(async (req, res) => {
  const settings = await ensureAvailable();
  const { text, tooLong } = sanitizeUserMessage(req.body?.message, settings.maxMessageLength);
  if (!text) throw ApiError.badRequest('Message is required');
  if (tooLong) throw ApiError.badRequest(`Message is too long (max ${settings.maxMessageLength} characters)`);
  // Invalid requests (above, and an unknown conversation) are rejected before anything is counted
  let conversation = req.body?.conversationId ? await findOwnConversation(req.body.conversationId, req.visitorHash) : null;

  const plan = buildQuotaPlan(req, settings);
  const quota = await reserveQuestion(plan);
  if (!quota.ok) return sendQuotaExceeded(res, plan, quota, settings);

  let history;
  let gate;
  try {
    if (!conversation) {
      conversation = await ChatConversation.create({
        visitorHash: req.visitorHash,
        visitorTag: req.visitorHash.slice(0, 8),
        title: text.replace(/\s+/g, ' ').slice(0, 80),
        userAgent: (req.get('user-agent') || '').slice(0, 300),
      });
    }
    identify(req, conversation);
    history = await loadHistory(conversation._id, { window: settings.historyWindow });
    const userMessage = await ChatMessage.create({ conversation: conversation._id, visitorHash: req.visitorHash, role: 'user', content: text });
    conversation.messageCount += 1;
    conversation.lastMessageAt = new Date();
    await conversation.save();
    gate = await classifyAndAuthorize(req, res, { conversation, history, message: text, userMessage, quota });
  } catch (err) {
    await refundQuestion(quota.reservation).catch(() => {});
    throw err;
  }
  if (!gate) return undefined;

  await respond(req, res, {
    conversation,
    history,
    message: text,
    visitorHash: req.visitorHash,
    reservation: quota.reservation,
    usage: quota.usage,
    ...gate,
  });
  return undefined;
});

// Replaces the last answer with a new one (or answers a question whose answer failed)
export const regenerate = asyncHandler(async (req, res) => {
  const settings = await ensureAvailable();
  const conversation = await findOwnConversation(req.params.id, req.visitorHash);

  const last = await ChatMessage.findOne({ conversation: conversation._id }).sort({ createdAt: -1, _id: -1 });
  if (!last) throw ApiError.badRequest('Nothing to regenerate');
  const lastUser = await ChatMessage.findOne({ conversation: conversation._id, role: 'user' }).sort({ createdAt: -1, _id: -1 });
  if (!lastUser) throw ApiError.badRequest('Nothing to regenerate');

  // A regenerated answer is another AI request, so it uses a question too
  const plan = buildQuotaPlan(req, settings);
  const quota = await reserveQuestion(plan);
  if (!quota.ok) return sendQuotaExceeded(res, plan, quota, settings);

  let history;
  let gate;
  try {
    history = await loadHistory(conversation._id, { window: settings.historyWindow, before: lastUser.createdAt });
    // Re-classified and re-authorised on every regeneration (this is also how a job
    // question continues after the visitor logs in or verifies their email)
    gate = await classifyAndAuthorize(req, res, { conversation, history, message: lastUser.content, userMessage: lastUser, quota });
  } catch (err) {
    await refundQuestion(quota.reservation).catch(() => {});
    throw err;
  }
  if (!gate) return undefined;
  await respond(req, res, {
    conversation,
    history,
    message: lastUser.content,
    visitorHash: req.visitorHash,
    reservation: quota.reservation,
    usage: quota.usage,
    ...gate,
    regenerated: true,
    replaces: last.role === 'assistant' ? last : null,
  });
});
