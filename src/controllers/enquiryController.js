import mongoose from 'mongoose';
import ChatEnquiry, { ENQUIRY_STATUSES, ENQUIRY_TYPES, SYNC_STATUSES } from '../models/ChatEnquiry.js';
import ChatEnquirySyncLog from '../models/ChatEnquirySyncLog.js';
import StoredFile from '../models/StoredFile.js';
import { odooRecordUrl } from '../services/odoo.js';
import { syncEnquiryNow } from '../services/recruitmentSync.js';
import { logAi } from '../ai/logger.js';
import ChatMessage from '../models/ChatMessage.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import { QUOTA_TIMEZONE, quotaDay, shiftDay } from '../ai/quotaService.js';

// Admin: AI Chatbot -> Job Queries (job enquiries from logged-in users and email-verified
// visitors, with their Odoo Recruitment sync). Mounted at /api/ai/job-queries for superadmins,
// admins and HR accounts. General conversations are in generalQueryController.js.

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const parseDate = (value, endOfDay = false) => {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return null;
  // Dates picked in the admin panel are IST calendar days
  const d = new Date(`${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}+05:30`);
  return Number.isNaN(d.getTime()) ? null : d;
};

const buildFilter = (q) => {
  const filter = {};
  if (ENQUIRY_TYPES.includes(q.type)) filter.type = q.type;
  if (ENQUIRY_STATUSES.includes(q.status)) filter.status = q.status;
  if (['registered', 'email_verified'].includes(q.authType)) filter.authType = q.authType;
  if (SYNC_STATUSES.includes(q.syncStatus)) filter['odoo.status'] = q.syncStatus;
  if (q.vacancy === 'general') filter.vacancy = null;
  else if (mongoose.isValidObjectId(q.vacancy)) filter.vacancy = q.vacancy;
  const from = parseDate(q.from);
  const to = parseDate(q.to, true);
  if (from || to) filter.lastAt = { ...(from && { $gte: from }), ...(to && { $lte: to }) };
  const search = String(q.search || '').trim().slice(0, 100);
  if (search) {
    const re = new RegExp(escapeRegex(search), 'i');
    filter.$or = [{ name: re }, { email: re }, { lastQuestion: re }, { vacancyTitle: re }, { 'candidate.name': re }, { 'candidate.phone': re }, { 'candidate.position': re }];
  }
  return filter;
};

const toItem = (e) => ({
  id: String(e._id),
  type: e.type,
  conversationId: String(e.conversation),
  authType: e.authType,
  name: e.candidate?.name || e.user?.name || e.name || '',
  email: e.email,
  phone: e.candidate?.phone || e.user?.phone || '',
  status: e.status,
  category: e.category,
  confidence: e.confidence,
  questionCount: e.questionCount,
  lastQuestion: e.lastQuestion,
  vacancy: e.vacancy ? { id: String(e.vacancy._id || e.vacancy), title: e.vacancy.title || e.vacancyTitle } : null,
  firstAt: e.firstAt,
  lastAt: e.lastAt,
  statusUpdatedAt: e.statusUpdatedAt || null,
  ...(e.type === 'job' && {
    candidate: e.candidate || {},
    position: e.candidate?.position || e.vacancy?.title || e.vacancyTitle || '',
    resume: e.resume?.file ? { name: e.resume.name, size: e.resume.size } : null,
    submittedAt: e.submittedAt || null,
    consentAt: e.consentAt || null,
    odoo: {
      status: e.odoo?.status || 'not_submitted',
      applicantId: e.odoo?.applicantId || null,
      // Only built from the confirmed applicant id and the configured Odoo URL
      url: e.odoo?.applicantId ? odooRecordUrl('hr.applicant', e.odoo.applicantId) : null,
      attachmentId: e.odoo?.attachmentId || null,
      attempts: e.odoo?.attempts || 0,
      lastAttemptAt: e.odoo?.lastAttemptAt || null,
      lastError: e.odoo?.lastError || '',
      nextRetryAt: e.odoo?.nextRetryAt || null,
      syncedAt: e.odoo?.syncedAt || null,
    },
  }),
});

export const listEnquiries = asyncHandler(async (req, res) => {
  req.query.type = 'job';
  const filter = buildFilter(req.query);
  // ?export=1 returns up to 5000 rows for CSV download
  const exporting = req.query.export === '1';
  const limit = exporting ? 5000 : Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
  const page = exporting ? 1 : Math.max(Number(req.query.page) || 1, 1);

  const [items, total, statusCounts, syncCounts] = await Promise.all([
    ChatEnquiry.find(filter)
      .sort({ lastAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate('user', 'name email phone')
      .populate('vacancy', 'title')
      .lean(),
    ChatEnquiry.countDocuments(filter),
    ChatEnquiry.aggregate([
      { $match: ENQUIRY_TYPES.includes(req.query.type) ? { type: req.query.type } : {} },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
    req.query.type === 'job' ? ChatEnquiry.aggregate([{ $match: { type: 'job' } }, { $group: { _id: '$odoo.status', count: { $sum: 1 } } }]) : [],
  ]);
  const syncStatusCounts = Object.fromEntries(SYNC_STATUSES.map((s) => [s, 0]));
  syncCounts.forEach((c) => {
    syncStatusCounts[c._id || 'not_submitted'] += c.count;
  });
  const counts = Object.fromEntries(ENQUIRY_STATUSES.map((s) => [s, 0]));
  statusCounts.forEach((c) => {
    counts[c._id] = c.count;
  });
  res.json({
    success: true,
    data: items.map(toItem),
    counts,
    ...(req.query.type === 'job' && { syncCounts: syncStatusCounts }),
    pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) },
  });
});

export const getEnquiry = asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw ApiError.notFound('Enquiry not found');
  const enquiry = await ChatEnquiry.findOne({ _id: req.params.id, type: 'job' }).populate('user', 'name email phone company city').populate('vacancy', 'title department location').lean();
  if (!enquiry) throw ApiError.notFound('Enquiry not found');
  const messages = await ChatMessage.find({ conversation: enquiry.conversation })
    .select('role content intent intentConfidence awaitingVerification createdAt sources')
    .sort({ createdAt: 1, _id: 1 })
    .limit(1000)
    .lean();
  res.json({
    success: true,
    data: {
      enquiry: { ...toItem(enquiry), user: enquiry.user || null, vacancy: enquiry.vacancy || null },
      messages: messages.map((m) => ({
        id: String(m._id),
        role: m.role,
        content: m.content,
        intent: m.intent || null,
        intentConfidence: m.intentConfidence ?? null,
        awaitingVerification: Boolean(m.awaitingVerification),
        createdAt: m.createdAt,
      })),
    },
  });
});

export const updateEnquiryStatus = asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw ApiError.notFound('Enquiry not found');
  const { status } = req.body || {};
  if (!ENQUIRY_STATUSES.includes(status)) throw ApiError.badRequest(`Status must be one of: ${ENQUIRY_STATUSES.join(', ')}`);
  const enquiry = await ChatEnquiry.findOneAndUpdate(
    { _id: req.params.id, type: 'job' },
    { status, statusUpdatedAt: new Date(), statusUpdatedBy: req.admin._id },
    { new: true }
  )
    .populate('user', 'name email phone')
    .populate('vacancy', 'title')
    .lean();
  if (!enquiry) throw ApiError.notFound('Enquiry not found');
  res.json({ success: true, message: 'Status updated', data: toItem(enquiry) });
});

export const getEnquiryStats = asyncHandler(async (req, res) => {
  const { day: today } = quotaDay();
  const dailyFrom = new Date(`${shiftDay(today, 29)}T00:00:00+05:30`);
  const monthStart = new Date(`${today.slice(0, 7)}-01T00:00:00Z`);
  monthStart.setUTCMonth(monthStart.getUTCMonth() - 11);
  const monthlyFrom = new Date(`${monthStart.toISOString().slice(0, 10)}T00:00:00+05:30`);
  const JOB = { type: 'job' };

  const series = (from, format) =>
    ChatEnquiry.aggregate([
      { $match: { ...JOB, firstAt: { $gte: from } } },
      { $group: { _id: { $dateToString: { format, date: '$firstAt', timezone: QUOTA_TIMEZONE } }, count: { $sum: 1 } } },
    ]);

  const [byStatus, bySync, uniqueEmails, uniqueVerifiedGuests, dailyRows, monthlyRows] = await Promise.all([
    ChatEnquiry.aggregate([{ $match: JOB }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
    ChatEnquiry.aggregate([{ $match: JOB }, { $group: { _id: '$odoo.status', count: { $sum: 1 } } }]),
    ChatEnquiry.distinct('email', JOB).then((v) => v.length),
    ChatEnquiry.distinct('email', { ...JOB, authType: 'email_verified' }).then((v) => v.length),
    series(dailyFrom, '%Y-%m-%d'),
    series(monthlyFrom, '%Y-%m'),
  ]);

  const totals = { all: 0, new: 0, in_progress: 0, resolved: 0 };
  byStatus.forEach(({ _id, count }) => {
    totals.all += count;
    totals[_id] = (totals[_id] || 0) + count;
  });
  const sync = Object.fromEntries(SYNC_STATUSES.map((s) => [s, 0]));
  bySync.forEach(({ _id, count }) => {
    sync[_id || 'not_submitted'] += count;
  });

  const fill = (rows, keys, label) => {
    const map = Object.fromEntries(rows.map((r) => [r._id, r.count]));
    return keys.map((key) => ({ key, label: label(key), job: map[key] || 0 }));
  };
  const dayKeys = Array.from({ length: 30 }, (_, i) => shiftDay(today, 29 - i));
  const monthKeys = Array.from({ length: 12 }, (_, i) => {
    const d = new Date(monthStart);
    d.setUTCMonth(d.getUTCMonth() + i);
    return d.toISOString().slice(0, 7);
  });

  res.json({
    success: true,
    data: {
      totals,
      sync,
      // Submitted applications not in Odoo yet
      pendingSync: sync.pending + sync.processing + sync.failed,
      requiresAttention: sync.requires_attention,
      uniqueUsers: uniqueEmails,
      uniqueVerifiedGuests,
      daily: fill(dailyRows, dayKeys, (k) => new Date(`${k}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })),
      monthly: fill(monthlyRows, monthKeys, (k) => new Date(`${k}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'short', year: '2-digit', timeZone: 'UTC' })),
    },
  });
});

// ---------- Odoo Recruitment sync (job enquiries) ----------

const findJobEnquiry = async (id) => {
  if (!mongoose.isValidObjectId(id)) throw ApiError.notFound('Enquiry not found');
  const enquiry = await ChatEnquiry.findOne({ _id: id, type: 'job' });
  if (!enquiry) throw ApiError.notFound('Job enquiry not found');
  return enquiry;
};

// POST /ai/enquiries/:id/sync  (Sync now / Retry)
export const syncEnquiry = asyncHandler(async (req, res) => {
  const enquiry = await findJobEnquiry(req.params.id);
  if (!enquiry.submittedAt) throw ApiError.badRequest('The candidate has not submitted this application yet, so it cannot be sent to Odoo.');
  const result = await syncEnquiryNow(enquiry._id, req.admin._id);
  if (result.busy) throw new ApiError(409, 'A sync for this enquiry is already running. Try again in a moment.');
  await logAi({
    level: 'info',
    source: 'recruitment',
    message: `${req.admin.email} ran an Odoo sync for job enquiry ${enquiry.id}: ${result.status}`,
    context: { enquiryId: enquiry.id },
  });
  const fresh = await ChatEnquiry.findById(enquiry._id).populate('user', 'name email phone').populate('vacancy', 'title').lean();
  res.status(result.status === 'synced' ? 200 : 502).json({
    success: result.status === 'synced',
    message: result.status === 'synced' ? `Synced to Odoo (applicant #${result.applicantId})` : result.error || 'Sync failed',
    data: toItem(fresh),
  });
});

// GET /ai/enquiries/:id/sync-logs
export const listSyncLogs = asyncHandler(async (req, res) => {
  const enquiry = await findJobEnquiry(req.params.id);
  const logs = await ChatEnquirySyncLog.find({ enquiry: enquiry._id }).sort({ createdAt: -1 }).limit(100).populate('admin', 'name email').lean();
  res.json({
    success: true,
    data: logs.map((l) => ({
      id: String(l._id),
      attempt: l.attempt,
      outcome: l.outcome,
      trigger: l.trigger,
      admin: l.admin ? l.admin.name || l.admin.email : null,
      applicantId: l.applicantId,
      attachmentId: l.attachmentId,
      error: l.error,
      nextRetryAt: l.nextRetryAt,
      durationMs: l.durationMs,
      createdAt: l.createdAt,
    })),
  });
});

// GET /ai/enquiries/:id/resume  (admins only; never a public URL)
export const getEnquiryResume = asyncHandler(async (req, res) => {
  const enquiry = await findJobEnquiry(req.params.id);
  const file = enquiry.resume?.file ? await StoredFile.findById(enquiry.resume.file) : null;
  if (!file) throw ApiError.notFound('No CV for this enquiry');
  const name = (enquiry.resume.name || file.filename || 'cv').replace(/["\\\r\n]/g, '');
  const ascii = name.replace(/[^\x20-\x7e]/g, '_');
  res.set({
    'Content-Type': file.contentType,
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
  });
  res.send(file.data);
});
