import ChatConversation from '../models/ChatConversation.js';
import ChatMessage from '../models/ChatMessage.js';
import ChatSettings from '../models/ChatSettings.js';
import { getChatClient, getEmbeddingClient } from './configService.js';
import { searchKnowledge } from './retrieval.js';
import { buildSystemPrompt, SUMMARY_SYSTEM_PROMPT } from './prompt.js';
import { cleanText } from './textExtract.js';
import { logAi } from './logger.js';

// Orchestrates one assistant reply: retrieval -> prompt -> configured model.

let settingsCache = { at: 0, doc: null };
export const getChatSettings = async () => {
  if (settingsCache.doc && Date.now() - settingsCache.at < 10000) return settingsCache.doc;
  const doc = await ChatSettings.getSingleton();
  settingsCache = { at: Date.now(), doc };
  return doc;
};
export const invalidateChatSettings = () => {
  settingsCache = { at: 0, doc: null };
};

export const sanitizeUserMessage = (text, maxLength) => {
  const clean = cleanText(typeof text === 'string' ? text : '');
  return { text: clean, tooLong: clean.length > maxLength };
};

// Providers such as Anthropic and Gemini require the history to start with a user turn and
// to alternate roles, so merge consecutive turns and drop leading assistant turns.
export const normalizeTurns = (turns) => {
  const out = [];
  turns.forEach((t) => {
    if (!t?.content?.trim()) return;
    if (!out.length && t.role !== 'user') return;
    const last = out[out.length - 1];
    if (last && last.role === t.role) last.content = `${last.content}\n\n${t.content}`;
    else out.push({ role: t.role, content: t.content });
  });
  return out;
};

// Follow-up questions ("what about pricing?") need earlier context to retrieve well
const retrievalQuery = (history, message) => {
  const previousUser = [...history].reverse().find((m) => m.role === 'user');
  return previousUser ? `${message}\n${previousUser.content.slice(0, 500)}` : message;
};

/**
 * Generates an assistant reply.
 * @param {object} p
 * @param {Array<{role, content}>} p.history  earlier turns (already windowed)
 * @param {string} p.message                  the new user message
 * @param {string} [p.summary]                summary of older turns
 * @param {AbortSignal} [p.signal]
 * @param {(text: string) => void} [p.onDelta] stream callback; omit for a non-streaming call
 * @param {(sources: Array) => void} [p.onSources]
 */
export const generateReply = async ({ history = [], message, summary = '', signal, onDelta, onSources }) => {
  const settings = await getChatSettings();
  const chatClient = await getChatClient();
  const embeddingClient = await getEmbeddingClient();

  let retrieval;
  try {
    retrieval = await searchKnowledge(retrievalQuery(history, message), {
      topK: settings.retrievalTopK,
      minRelevance: settings.minRelevance,
      embeddingClient,
      signal,
    });
  } catch (err) {
    err.stage = 'retrieval';
    err.client = embeddingClient;
    throw err;
  }

  // One numbered source per knowledge entry (its chunks grouped), so the [n] citations in the
  // answer match the n-th item of `sources` shown to the visitor
  const grouped = [];
  retrieval.results.forEach((r) => {
    const existing = grouped.find((g) => g.entryId === r.entryId);
    if (existing) existing.texts.push(r.text);
    else grouped.push({ entryId: r.entryId, title: r.title, category: r.category, score: r.score, texts: [r.text] });
  });
  const sources = grouped.map((g) => ({ entry: g.entryId, title: g.title, category: g.category, score: g.score }));
  onSources?.(sources);

  const system = buildSystemPrompt({
    settings,
    contexts: grouped.map((g) => ({ title: g.title, category: g.category, text: g.texts.join('\n[…]\n') })),
    summary,
  });
  const messages = normalizeTurns([...history, { role: 'user', content: message }]);

  const started = Date.now();
  try {
    const result = await chatClient.chat({
      system,
      messages,
      temperature: typeof settings.temperature === 'number' ? settings.temperature : undefined,
      maxTokens: settings.maxOutputTokens,
      signal,
      onDelta,
    });
    return {
      ...result,
      sources,
      retrievalMode: retrieval.mode,
      contexts: retrieval.results,
      provider: chatClient.provider,
      model: chatClient.model,
      latencyMs: Date.now() - started,
    };
  } catch (err) {
    err.stage = 'generation';
    err.client = chatClient;
    throw err;
  }
};

// Messages that fit in the history window, oldest first
export const loadHistory = async (conversationId, { window, before } = {}) => {
  const filter = { conversation: conversationId };
  if (before) filter.createdAt = { $lt: before };
  const rows = await ChatMessage.find(filter).sort({ createdAt: -1, _id: -1 }).limit(window).select('role content').lean();
  return rows.reverse().map((m) => ({ role: m.role, content: m.content }));
};

const summarizing = new Set();

// Folds messages that fell out of the history window into the conversation summary.
// Runs after the reply was sent, with the same configured model (no other model is used).
export const updateSummaryIfNeeded = async (conversationId) => {
  const key = String(conversationId);
  if (summarizing.has(key)) return;
  summarizing.add(key);
  let client;
  try {
    const settings = await getChatSettings();
    const conversation = await ChatConversation.findById(conversationId);
    if (!conversation) return;
    const total = await ChatMessage.countDocuments({ conversation: conversationId });
    const outside = total - settings.historyWindow;
    // Summarise in batches of at least 4 messages to limit extra model calls
    if (outside - conversation.summarizedCount < 4) return;

    const older = await ChatMessage.find({ conversation: conversationId })
      .sort({ createdAt: 1, _id: 1 })
      .skip(conversation.summarizedCount)
      .limit(outside - conversation.summarizedCount)
      .select('role content')
      .lean();

    const transcript = older.map((m) => `${m.role === 'user' ? 'Visitor' : 'Assistant'}: ${m.content.slice(0, 1500)}`).join('\n\n');
    client = await getChatClient();
    const result = await client.chat({
      system: SUMMARY_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `${conversation.summary ? `Existing summary:\n${conversation.summary}\n\n` : ''}New transcript to add:\n<transcript>\n${transcript}\n</transcript>`,
        },
      ],
      maxTokens: 400,
    });
    if (result.text?.trim()) {
      conversation.summary = result.text.trim().slice(0, 4000);
      conversation.summarizedCount = outside;
      conversation.totalInputTokens += result.usage?.inputTokens || 0;
      conversation.totalOutputTokens += result.usage?.outputTokens || 0;
      await conversation.save();
    }
  } catch (err) {
    await logAi({
      level: 'warn',
      source: 'summary',
      message: `Conversation summary failed: ${err.message}`,
      code: err.code,
      provider: client?.provider,
      model: client?.model,
      providerStatus: err.providerStatus,
      context: { conversationId: key },
      secrets: client?.secrets,
    });
  } finally {
    summarizing.delete(key);
  }
};
