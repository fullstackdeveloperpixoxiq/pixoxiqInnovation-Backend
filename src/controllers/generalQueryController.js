import mongoose from 'mongoose';
import ChatConversation from '../models/ChatConversation.js';
import ChatMessage from '../models/ChatMessage.js';
import User from '../models/User.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import { TOPICS } from '../ai/intentService.js';
import { QUOTA_TIMEZONE, quotaDay, shiftDay } from '../ai/quotaService.js';
import { logAi } from '../ai/logger.js';

// Admin: AI Chatbot -> Normal / General Queries. Every non-recruitment conversation, read from
// the existing conversation records (no copies). Identity is shown only for logged-in users;
// anonymous visitors appear as an anonymous tag (no email, not even one typed in the chat).
// These conversations are never sent to Odoo Recruitment.

const GENERAL = { queryType: { $ne: 'job' } };
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const parseDate = (value, endOfDay = false) => {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return null;
  const d = new Date(`${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}+05:30`);
  return Number.isNaN(d.getTime()) ? null : d;
};

const toItem = (c) => {
  const authenticated = Boolean(c.user);
  return {
    id: String(c._id),
    title: c.title,
    authenticated,
    user: authenticated ? { name: c.user.name || '', email: c.user.email || '' } : null,
    visitorTag: authenticated ? '' : c.visitorTag,
    topic: c.topic || 'other',
    messageCount: c.messageCount,
    firstAt: c.createdAt,
    lastAt: c.lastMessageAt,
    status: c.adminStatus || 'open',
    archivedAt: c.archivedAt || null,
  };
};

export const listGeneralQueries = asyncHandler(async (req, res) => {
  const q = req.query;
  const filter = { ...GENERAL, adminStatus: q.status === 'archived' ? 'archived' : { $ne: 'archived' } };
  if (q.status === 'all') delete filter.adminStatus;
  if (TOPICS.includes(q.topic)) filter.topic = q.topic === 'other' ? { $in: ['other', '', null] } : q.topic;
  if (q.auth === 'authenticated') filter.user = { $ne: null };
  else if (q.auth === 'anonymous') filter.user = null;
  const from = parseDate(q.from);
  const to = parseDate(q.to, true);
  if (from || to) filter.lastMessageAt = { ...(from && { $gte: from }), ...(to && { $lte: to }) };

  const search = String(q.search || '').trim().slice(0, 100);
  if (search) {
    const re = new RegExp(escapeRegex(search), 'i');
    const [users, inMessages] = await Promise.all([
      User.find({ $or: [{ name: re }, { email: re }] }).select('_id').limit(200).lean(),
      ChatMessage.aggregate([{ $match: { content: re } }, { $group: { _id: '$conversation' } }, { $limit: 500 }]),
    ]);
    filter.$or = [{ title: re }, { user: { $in: users.map((u) => u._id) } }, { _id: { $in: inMessages.map((m) => m._id) } }];
  }

  const limit = Math.min(Math.max(Number(q.limit) || 20, 1), 100);
  const page = Math.max(Number(q.page) || 1, 1);
  const [items, total] = await Promise.all([
    ChatConversation.find(filter).sort({ lastMessageAt: -1 }).skip((page - 1) * limit).limit(limit).populate('user', 'name email').lean(),
    ChatConversation.countDocuments(filter),
  ]);
  res.json({ success: true, data: items.map(toItem), pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) } });
});

const findGeneral = async (id) => {
  if (!mongoose.isValidObjectId(id)) throw ApiError.notFound('Conversation not found');
  const conversation = await ChatConversation.findOne({ _id: id, ...GENERAL }).populate('user', 'name email');
  if (!conversation) throw ApiError.notFound('Conversation not found');
  return conversation;
};

export const getGeneralQuery = asyncHandler(async (req, res) => {
  const conversation = await findGeneral(req.params.id);
  const messages = await ChatMessage.find({ conversation: conversation._id })
    .select('role content topic intent createdAt interrupted')
    .sort({ createdAt: 1, _id: 1 })
    .limit(1000)
    .lean();
  res.json({
    success: true,
    data: {
      conversation: toItem(conversation.toObject()),
      messages: messages.map((m) => ({ id: String(m._id), role: m.role, content: m.content, topic: m.topic || null, interrupted: Boolean(m.interrupted), createdAt: m.createdAt })),
    },
  });
});

// PATCH /:id/archive { archived: true|false }
export const archiveGeneralQuery = asyncHandler(async (req, res) => {
  if (typeof req.body?.archived !== 'boolean') throw ApiError.badRequest('archived must be true or false');
  const conversation = await findGeneral(req.params.id);
  conversation.adminStatus = req.body.archived ? 'archived' : 'open';
  conversation.archivedAt = req.body.archived ? new Date() : undefined;
  conversation.archivedBy = req.body.archived ? req.admin._id : undefined;
  await conversation.save();
  await logAi({ level: 'info', source: 'chat', message: `${req.admin.email} ${req.body.archived ? 'archived' : 'restored'} general conversation ${conversation.id}` });
  res.json({ success: true, message: req.body.archived ? 'Conversation archived' : 'Conversation restored', data: toItem(conversation.toObject()) });
});

// Aggregates only: anonymous activity is counted, never listed with identity here
export const getGeneralQueryStats = asyncHandler(async (req, res) => {
  const { day: today } = quotaDay();
  const dailyFrom = new Date(`${shiftDay(today, 29)}T00:00:00+05:30`);
  const monthStart = new Date(`${today.slice(0, 7)}-01T00:00:00Z`);
  monthStart.setUTCMonth(monthStart.getUTCMonth() - 11);
  const monthlyFrom = new Date(`${monthStart.toISOString().slice(0, 10)}T00:00:00+05:30`);

  const series = (from, format) =>
    ChatConversation.aggregate([
      { $match: { ...GENERAL, createdAt: { $gte: from } } },
      {
        $group: {
          _id: { key: { $dateToString: { format, date: '$createdAt', timezone: QUOTA_TIMEZONE } }, auth: { $cond: [{ $ifNull: ['$user', false] }, 'authenticated', 'anonymous'] } },
          count: { $sum: 1 },
        },
      },
    ]);

  const [total, authenticated, archived, byTopic, dailyRows, monthlyRows] = await Promise.all([
    ChatConversation.countDocuments(GENERAL),
    ChatConversation.countDocuments({ ...GENERAL, user: { $ne: null } }),
    ChatConversation.countDocuments({ ...GENERAL, adminStatus: 'archived' }),
    ChatConversation.aggregate([{ $match: GENERAL }, { $group: { _id: { $ifNull: ['$topic', ''] }, count: { $sum: 1 } } }, { $sort: { count: -1 } }]),
    series(dailyFrom, '%Y-%m-%d'),
    series(monthlyFrom, '%Y-%m'),
  ]);

  const fill = (rows, keys, label) => {
    const map = {};
    rows.forEach(({ _id, count }) => {
      map[_id.key] = { ...(map[_id.key] || {}), [_id.auth]: count };
    });
    return keys.map((key) => ({ key, label: label(key), authenticated: map[key]?.authenticated || 0, anonymous: map[key]?.anonymous || 0 }));
  };
  const topics = {};
  byTopic.forEach(({ _id, count }) => {
    const t = TOPICS.includes(_id) ? _id : 'other';
    topics[t] = (topics[t] || 0) + count;
  });

  res.json({
    success: true,
    data: {
      total,
      authenticated,
      anonymous: total - authenticated,
      archived,
      topics: Object.entries(topics)
        .map(([topic, count]) => ({ topic, count }))
        .sort((a, b) => b.count - a.count),
      daily: fill(dailyRows, Array.from({ length: 30 }, (_, i) => shiftDay(today, 29 - i)), (k) =>
        new Date(`${k}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })
      ),
      monthly: fill(
        monthlyRows,
        Array.from({ length: 12 }, (_, i) => {
          const d = new Date(monthStart);
          d.setUTCMonth(d.getUTCMonth() + i);
          return d.toISOString().slice(0, 7);
        }),
        (k) => new Date(`${k}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'short', year: '2-digit', timeZone: 'UTC' })
      ),
    },
  });
});
