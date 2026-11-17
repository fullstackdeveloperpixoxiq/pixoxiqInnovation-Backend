import crypto from 'crypto';
import mongoose from 'mongoose';
import ChatConversation from '../models/ChatConversation.js';
import ChatMessage from '../models/ChatMessage.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import { sha256 } from '../ai/crypto.js';
import { getChatClient, getConfigSummary } from '../ai/configService.js';
import {
  generateReply,
  getChatSettings,
  loadHistory,
  sanitizeUserMessage,
  updateSummaryIfNeeded,
} from '../ai/chatService.js';
import { logAi } from '../ai/logger.js';

// Public endpoints of the PIXOXIQ AI Assistant used by the website.
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

const toPublicMessage = (m) => ({
  id: String(m._id || m.id),
  role: m.role,
  content: m.content,
  sources: (m.sources || []).map((s) => ({ title: s.title, category: s.category })),
  interrupted: Boolean(m.interrupted),
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

const enforceDailyLimit = async (visitorHash, settings) => {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [sent, regenerated] = await Promise.all([
    ChatMessage.countDocuments({ visitorHash, role: 'user', createdAt: { $gte: since } }),
    ChatMessage.countDocuments({ visitorHash, role: 'assistant', regenerated: true, createdAt: { $gte: since } }),
  ]);
  if (sent + regenerated >= settings.dailyMessageLimit) {
    throw new ApiError(429, 'You have reached the daily message limit. Please try again tomorrow or contact us directly.');
  }
};

const publicErrorMessage = (err) => {
  if (err.code === 'rate_limited') return 'The assistant is receiving a lot of requests right now. Please try again in a moment.';
  if (err.code === 'timeout') return 'The assistant took too long to respond. Please try again.';
  return 'The assistant could not answer right now. Please try again later.';
};

// Generates the assistant reply and streams it as Server-Sent Events (or JSON with ?stream=0).
// Events: meta, sources, delta, done, error.
const respond = async (req, res, { conversation, history, message, visitorHash, regenerated = false }) => {
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
  }

  let partial = '';
  let sources = [];
  try {
    const result = await generateReply({
      history,
      message,
      summary: conversation.summary,
      signal: controller.signal,
      onSources: (s) => {
        sources = s;
        send('sources', s.map((x) => ({ title: x.title, category: x.category })));
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
        message: `The model returned an empty answer (finish reason: ${result.finishReason || 'unknown'})`,
        provider: result.provider,
        model: result.model,
        context: { conversationId: String(conversation._id) },
      });
      content = "I'm sorry, I couldn't produce an answer to that. Could you rephrase your question?";
      send('delta', { text: content });
    }

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

    conversation.messageCount += 1;
    conversation.lastMessageAt = new Date();
    conversation.totalInputTokens += result.usage?.inputTokens || 0;
    conversation.totalOutputTokens += result.usage?.outputTokens || 0;
    await conversation.save();

    if (streaming) {
      send('done', { message: toPublicMessage(assistant), conversation: toPublicConversation(conversation) });
      res.end();
    } else {
      res.json({ success: true, data: { message: toPublicMessage(assistant), conversation: toPublicConversation(conversation) } });
    }

    updateSummaryIfNeeded(conversation._id);
  } catch (err) {
    const clientGone = controller.signal.aborted && err.code === 'aborted';
    if (clientGone) {
      // Visitor pressed stop / closed the page: keep what was already shown
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
        conversation.messageCount += 1;
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

    if (streaming) {
      send('error', { message: publicErrorMessage(err), conversation: toPublicConversation(conversation) });
      res.end();
    } else {
      throw new ApiError(err.code === 'rate_limited' ? 429 : 503, publicErrorMessage(err));
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
  await conversation.deleteOne();
  res.json({ success: true, message: 'Conversation deleted', data: { id: String(conversation._id) } });
});

export const sendMessage = asyncHandler(async (req, res) => {
  const settings = await ensureAvailable();
  const { text, tooLong } = sanitizeUserMessage(req.body?.message, settings.maxMessageLength);
  if (!text) throw ApiError.badRequest('Message is required');
  if (tooLong) throw ApiError.badRequest(`Message is too long (max ${settings.maxMessageLength} characters)`);
  await enforceDailyLimit(req.visitorHash, settings);

  let conversation;
  if (req.body?.conversationId) {
    conversation = await findOwnConversation(req.body.conversationId, req.visitorHash);
  } else {
    conversation = await ChatConversation.create({
      visitorHash: req.visitorHash,
      visitorTag: req.visitorHash.slice(0, 8),
      title: text.replace(/\s+/g, ' ').slice(0, 80),
      userAgent: (req.get('user-agent') || '').slice(0, 300),
    });
  }

  const history = await loadHistory(conversation._id, { window: settings.historyWindow });
  await ChatMessage.create({ conversation: conversation._id, visitorHash: req.visitorHash, role: 'user', content: text });
  conversation.messageCount += 1;
  conversation.lastMessageAt = new Date();
  await conversation.save();

  await respond(req, res, { conversation, history, message: text, visitorHash: req.visitorHash });
});

// Replaces the last answer with a new one (or answers a question whose answer failed)
export const regenerate = asyncHandler(async (req, res) => {
  const settings = await ensureAvailable();
  const conversation = await findOwnConversation(req.params.id, req.visitorHash);
  await enforceDailyLimit(req.visitorHash, settings);

  const last = await ChatMessage.findOne({ conversation: conversation._id }).sort({ createdAt: -1, _id: -1 });
  if (!last) throw ApiError.badRequest('Nothing to regenerate');
  if (last.role === 'assistant') {
    await last.deleteOne();
    conversation.messageCount = Math.max(0, conversation.messageCount - 1);
  }
  const lastUser = await ChatMessage.findOne({ conversation: conversation._id, role: 'user' }).sort({ createdAt: -1, _id: -1 });
  if (!lastUser) throw ApiError.badRequest('Nothing to regenerate');

  const history = await loadHistory(conversation._id, { window: settings.historyWindow, before: lastUser.createdAt });
  await respond(req, res, {
    conversation,
    history,
    message: lastUser.content,
    visitorHash: req.visitorHash,
    regenerated: true,
  });
});
