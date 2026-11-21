import mongoose from 'mongoose';
import ChatConversation from '../models/ChatConversation.js';
import ChatMessage from '../models/ChatMessage.js';
import KnowledgeEntry, { KNOWLEDGE_STATUSES } from '../models/KnowledgeEntry.js';
import KnowledgeChunk from '../models/KnowledgeChunk.js';
import AiLog, { AI_LOG_SOURCES } from '../models/AiLog.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import { paginate } from '../utils/queryBuilder.js';
import { getActiveEmbeddingKey, getConfigSummary } from '../ai/configService.js';
import { getChatSettings } from '../ai/chatService.js';
import { queueLength } from '../ai/indexer.js';

// AI assistant dashboard, usage analytics, error logs and conversation review (admins).

const DAY = 24 * 60 * 60 * 1000;

const startOfDayUtc = (daysAgo) => {
  const d = new Date(Date.now() - daysAgo * DAY);
  d.setUTCHours(0, 0, 0, 0);
  return d;
};

// Daily messages, conversations and tokens since `since`, gaps filled with 0
const dailySeries = async (since, days) => {
  const [msgRows, convRows] = await Promise.all([
    ChatMessage.aggregate([
      { $match: { createdAt: { $gte: since } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
          messages: { $sum: { $cond: [{ $eq: ['$role', 'user'] }, 1, 0] } },
          answers: { $sum: { $cond: [{ $eq: ['$role', 'assistant'] }, 1, 0] } },
          inputTokens: { $sum: { $ifNull: ['$usage.inputTokens', 0] } },
          outputTokens: { $sum: { $ifNull: ['$usage.outputTokens', 0] } },
        },
      },
    ]),
    ChatConversation.aggregate([
      { $match: { createdAt: { $gte: since } } },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, conversations: { $sum: 1 } } },
    ]),
  ]);
  const msgs = Object.fromEntries(msgRows.map((r) => [r._id, r]));
  const convs = Object.fromEntries(convRows.map((r) => [r._id, r.conversations]));
  const out = [];
  for (let i = 0; i < days; i += 1) {
    const d = new Date(since.getTime() + i * DAY);
    const key = d.toISOString().slice(0, 10);
    out.push({
      date: key,
      label: d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }),
      messages: msgs[key]?.messages || 0,
      answers: msgs[key]?.answers || 0,
      conversations: convs[key] || 0,
      inputTokens: msgs[key]?.inputTokens || 0,
      outputTokens: msgs[key]?.outputTokens || 0,
    });
  }
  return out;
};

const knowledgeStats = async () => {
  const activeKey = await getActiveEmbeddingKey();
  const [entries, active, grouped, chunks, staleChunks, byCategory] = await Promise.all([
    KnowledgeEntry.countDocuments(),
    KnowledgeEntry.countDocuments({ isActive: true }),
    KnowledgeEntry.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
    KnowledgeChunk.countDocuments(),
    activeKey ? KnowledgeChunk.countDocuments({ embeddingKey: { $ne: activeKey } }) : 0,
    KnowledgeEntry.aggregate([{ $group: { _id: '$category', count: { $sum: 1 } } }, { $sort: { count: -1 } }]),
  ]);
  const byStatus = Object.fromEntries(KNOWLEDGE_STATUSES.map((s) => [s, 0]));
  grouped.forEach((g) => {
    byStatus[g._id] = g.count;
  });
  return {
    entries,
    active,
    byStatus,
    chunks,
    staleChunks,
    queue: queueLength(),
    retrievalMode: activeKey ? 'hybrid' : 'keyword',
    byCategory: byCategory.map((c) => ({ name: c._id, value: c.count })),
  };
};

export const getOverview = asyncHandler(async (req, res) => {
  const since30 = startOfDayUtc(29);
  const since24h = new Date(Date.now() - DAY);
  const since7 = new Date(Date.now() - 7 * DAY);

  const [
    conversations,
    messages,
    userMessages,
    messages24h,
    activeVisitors,
    tokenTotals,
    latency,
    errors7d,
    config,
    settings,
    knowledge,
    daily,
    recentConversations,
    recentErrors,
  ] = await Promise.all([
    ChatConversation.countDocuments(),
    ChatMessage.countDocuments(),
    ChatMessage.countDocuments({ role: 'user' }),
    ChatMessage.countDocuments({ role: 'user', createdAt: { $gte: since24h } }),
    ChatConversation.distinct('visitorHash', { lastMessageAt: { $gte: since30 } }).then((v) => v.length),
    ChatMessage.aggregate([
      { $match: { role: 'assistant' } },
      {
        $group: {
          _id: null,
          input: { $sum: { $ifNull: ['$usage.inputTokens', 0] } },
          output: { $sum: { $ifNull: ['$usage.outputTokens', 0] } },
        },
      },
    ]),
    ChatMessage.aggregate([
      { $match: { role: 'assistant', latencyMs: { $gt: 0 }, createdAt: { $gte: since30 } } },
      { $group: { _id: null, avg: { $avg: '$latencyMs' } } },
    ]),
    AiLog.countDocuments({ level: 'error', createdAt: { $gte: since7 } }),
    getConfigSummary(),
    getChatSettings(),
    knowledgeStats(),
    dailySeries(since30, 30),
    ChatConversation.find().sort({ lastMessageAt: -1 }).limit(8).lean(),
    AiLog.find({ level: 'error' }).sort({ createdAt: -1 }).limit(5),
  ]);

  res.json({
    success: true,
    data: {
      totals: {
        conversations,
        messages,
        userMessages,
        messages24h,
        activeVisitors,
        inputTokens: tokenTotals[0]?.input || 0,
        outputTokens: tokenTotals[0]?.output || 0,
        avgLatencyMs: Math.round(latency[0]?.avg || 0),
        errors7d,
      },
      status: {
        enabled: settings.enabled,
        live: Boolean(settings.enabled && config.chat.configured),
        chat: config.chat,
        embedding: config.embedding,
      },
      knowledge,
      daily,
      recentConversations: recentConversations.map((c) => ({
        id: String(c._id),
        title: c.title,
        messageCount: c.messageCount,
        lastMessageAt: c.lastMessageAt,
        visitorTag: c.visitorTag,
        visitorEmail: c.visitorEmail,
      })),
      recentErrors,
    },
  });
});

export const getUsage = asyncHandler(async (req, res) => {
  const days = [7, 30, 90].includes(Number(req.query.days)) ? Number(req.query.days) : 30;
  const since = startOfDayUtc(days - 1);
  const [daily, byModel] = await Promise.all([
    dailySeries(since, days),
    ChatMessage.aggregate([
      { $match: { role: 'assistant', createdAt: { $gte: since } } },
      {
        $group: {
          _id: { provider: '$provider', model: '$model' },
          answers: { $sum: 1 },
          inputTokens: { $sum: { $ifNull: ['$usage.inputTokens', 0] } },
          outputTokens: { $sum: { $ifNull: ['$usage.outputTokens', 0] } },
          avgLatencyMs: { $avg: '$latencyMs' },
          interrupted: { $sum: { $cond: ['$interrupted', 1, 0] } },
        },
      },
      { $sort: { answers: -1 } },
    ]),
  ]);
  const totals = daily.reduce(
    (acc, d) => ({
      messages: acc.messages + d.messages,
      answers: acc.answers + d.answers,
      conversations: acc.conversations + d.conversations,
      inputTokens: acc.inputTokens + d.inputTokens,
      outputTokens: acc.outputTokens + d.outputTokens,
    }),
    { messages: 0, answers: 0, conversations: 0, inputTokens: 0, outputTokens: 0 }
  );
  res.json({
    success: true,
    data: {
      days,
      totals,
      daily,
      byModel: byModel.map((m) => ({
        provider: m._id.provider || 'unknown',
        model: m._id.model || 'unknown',
        answers: m.answers,
        inputTokens: m.inputTokens,
        outputTokens: m.outputTokens,
        avgLatencyMs: Math.round(m.avgLatencyMs || 0),
        interrupted: m.interrupted,
      })),
    },
  });
});

export const listLogs = asyncHandler(async (req, res) => {
  const query = { ...req.query };
  if (query.source && !AI_LOG_SOURCES.includes(query.source)) delete query.source;
  const { items, pagination } = await paginate(AiLog, query, {
    searchFields: ['message', 'provider', 'model', 'code'],
    filterFields: ['level', 'source'],
    defaultSort: '-createdAt',
  });
  res.json({ success: true, data: items, pagination });
});

export const clearLogs = asyncHandler(async (req, res) => {
  const result = await AiLog.deleteMany({});
  res.json({ success: true, message: `${result.deletedCount} log entries deleted` });
});

export const listConversations = asyncHandler(async (req, res) => {
  const { items, pagination } = await paginate(ChatConversation, req.query, {
    searchFields: ['title', 'visitorTag', 'visitorEmail'],
    filterFields: ['visitorTag'],
    defaultSort: '-lastMessageAt',
    populate: { path: 'user', select: 'name email phone' },
  });
  res.json({ success: true, data: items, pagination });
});

export const getConversation = asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw ApiError.notFound('Conversation not found');
  const conversation = await ChatConversation.findById(req.params.id).select('+userAgent').populate('user', 'name email phone company');
  if (!conversation) throw ApiError.notFound('Conversation not found');
  const messages = await ChatMessage.find({ conversation: conversation._id }).sort({ createdAt: 1, _id: 1 }).limit(1000);
  res.json({ success: true, data: { conversation, messages } });
});

export const deleteConversation = asyncHandler(async (req, res) => {
  const conversation = await ChatConversation.findByIdAndDelete(req.params.id);
  if (!conversation) throw ApiError.notFound('Conversation not found');
  await ChatMessage.deleteMany({ conversation: conversation._id });
  res.json({ success: true, message: 'Conversation deleted', data: { id: conversation.id } });
});
