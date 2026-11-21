import mongoose from 'mongoose';
import Subscriber, { SUBSCRIBER_STATUSES } from '../models/Subscriber.js';
import NewsletterCampaign from '../models/NewsletterCampaign.js';
import Announcement from '../models/Announcement.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import { paginate, buildListQuery } from '../utils/queryBuilder.js';
import { pickFields } from './crudFactory.js';
import {
  sendEmail,
  isEmailConfigured,
  emailStatus,
  newToken,
  hashToken,
  verificationEmail,
  newsletterEmail,
  isValidUnsubscribeToken,
} from '../services/emailService.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const VERIFY_TTL_MS = 48 * 60 * 60 * 1000;
const RESEND_COOLDOWN_MS = 2 * 60 * 1000;

const normaliseEmail = (value) => (typeof value === 'string' ? value.trim().toLowerCase() : '');

// ---------- Public ----------

// Body: { email, source?, website? (honeypot) }
export const subscribe = asyncHandler(async (req, res) => {
  if (req.body.website) {
    return res.status(201).json({ success: true, message: 'Please check your inbox to confirm your subscription.' });
  }

  const email = normaliseEmail(req.body.email);
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) throw ApiError.badRequest('Enter a valid email address');
  const source = typeof req.body.source === 'string' ? req.body.source.slice(0, 40) : 'footer';

  let subscriber = await Subscriber.findOne({ email }).select('+verificationSentAt');

  if (subscriber?.status === 'subscribed') {
    return res.json({ success: true, data: { status: 'subscribed' }, message: "You're already subscribed. Thanks for staying with us!" });
  }
  if (
    subscriber?.status === 'pending' &&
    subscriber.verificationSentAt &&
    Date.now() - subscriber.verificationSentAt.getTime() < RESEND_COOLDOWN_MS
  ) {
    return res.json({
      success: true,
      data: { status: 'pending' },
      message: 'We already sent you a confirmation email. Please check your inbox (and spam folder).',
    });
  }

  if (!subscriber) subscriber = new Subscriber({ email, source });
  subscriber.ip = req.ip;

  // Without an email service there is no way to verify: confirm straight away
  if (!isEmailConfigured()) {
    subscriber.status = 'subscribed';
    subscriber.subscribedAt = new Date();
    subscriber.unsubscribedAt = undefined;
    try {
      await subscriber.save();
    } catch (err) {
      if (err.code === 11000) {
        return res.json({ success: true, data: { status: 'subscribed' }, message: "You're already subscribed." });
      }
      throw err;
    }
    return res.status(201).json({ success: true, data: { status: 'subscribed' }, message: "You're subscribed! Welcome aboard." });
  }

  const token = newToken();
  subscriber.status = 'pending';
  subscriber.verifyTokenHash = hashToken(token);
  subscriber.verifyExpires = new Date(Date.now() + VERIFY_TTL_MS);
  subscriber.verificationSentAt = new Date();
  try {
    await subscriber.save();
  } catch (err) {
    if (err.code === 11000) {
      return res.json({ success: true, data: { status: 'pending' }, message: 'Please check your inbox to confirm your subscription.' });
    }
    throw err;
  }

  try {
    await sendEmail({ to: email, ...verificationEmail(token) });
  } catch (err) {
    console.error('Newsletter verification email failed:', err.message);
    // Let the visitor retry immediately
    await Subscriber.updateOne({ _id: subscriber._id }, { $unset: { verificationSentAt: 1 } });
    throw new ApiError(503, "We couldn't send the confirmation email right now. Please try again in a few minutes.");
  }

  res.status(201).json({
    success: true,
    data: { status: 'pending' },
    message: 'Almost there! Check your inbox and click the link to confirm your subscription.',
  });
});

// Body: { token }
export const verify = asyncHandler(async (req, res) => {
  const { token } = req.body;
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) throw ApiError.badRequest('Invalid confirmation link');

  const subscriber = await Subscriber.findOne({ verifyTokenHash: hashToken(token) }).select('+verifyExpires');
  if (!subscriber) throw ApiError.badRequest('This confirmation link is invalid or has already been used.');
  if (!subscriber.verifyExpires || subscriber.verifyExpires < new Date()) {
    throw ApiError.badRequest('This confirmation link has expired. Please subscribe again to get a new one.');
  }

  subscriber.status = 'subscribed';
  subscriber.subscribedAt = new Date();
  subscriber.unsubscribedAt = undefined;
  subscriber.verifyTokenHash = undefined;
  subscriber.verifyExpires = undefined;
  await subscriber.save();
  res.json({ success: true, message: 'Your subscription is confirmed. Welcome to the PIXOXIQ newsletter!' });
});

// Body or query: { id, token }. Also the RFC 8058 one-click target used by mail clients.
export const unsubscribe = asyncHandler(async (req, res) => {
  const id = req.body?.id || req.query.id;
  const token = req.body?.token || req.query.token;
  if (typeof id !== 'string' || !mongoose.isValidObjectId(id) || !isValidUnsubscribeToken(id, token)) {
    throw ApiError.badRequest('This unsubscribe link is invalid.');
  }
  const subscriber = await Subscriber.findById(id);
  if (!subscriber) throw ApiError.notFound('Subscription not found');
  if (subscriber.status !== 'unsubscribed') {
    subscriber.status = 'unsubscribed';
    subscriber.unsubscribedAt = new Date();
    await subscriber.save();
  }
  res.json({ success: true, data: { email: subscriber.email }, message: "You've been unsubscribed. You won't receive further newsletters." });
});

// ---------- Admin: subscribers ----------

const LIST_OPTIONS = { searchFields: ['email'], filterFields: ['status'], defaultSort: '-createdAt' };

export const listSubscribers = asyncHandler(async (req, res) => {
  const { items, pagination } = await paginate(Subscriber, req.query, LIST_OPTIONS);
  const grouped = await Subscriber.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]);
  const counts = Object.fromEntries(SUBSCRIBER_STATUSES.map((s) => [s, 0]));
  grouped.forEach((g) => {
    counts[g._id] = g.count;
  });
  res.json({ success: true, data: items, pagination, counts, email: emailStatus() });
});

// CSV of all subscribers matching the current filters
const csvCell = (value) => {
  let s = value === null || value === undefined ? '' : String(value);
  // Neutralise spreadsheet formulas (CSV injection)
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export const exportSubscribers = asyncHandler(async (req, res) => {
  const { filter } = buildListQuery(req.query, LIST_OPTIONS);
  const rows = await Subscriber.find(filter).sort('-createdAt').limit(100000).lean();
  const iso = (d) => (d ? new Date(d).toISOString() : '');
  const lines = [
    ['Email', 'Status', 'Source', 'Subscribed at', 'Unsubscribed at', 'Created at'].join(','),
    ...rows.map((r) =>
      [r.email, r.status, r.source, iso(r.subscribedAt), iso(r.unsubscribedAt), iso(r.createdAt)].map(csvCell).join(',')
    ),
  ];
  const date = new Date().toISOString().slice(0, 10);
  res.set({
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="newsletter-subscribers-${date}.csv"`,
  });
  res.send(`﻿${lines.join('\n')}`);
});

// Body: { status: 'subscribed' | 'unsubscribed' }
export const updateSubscriber = asyncHandler(async (req, res) => {
  const { status } = req.body;
  if (!['subscribed', 'unsubscribed'].includes(status)) throw ApiError.badRequest('Invalid status');
  const subscriber = await Subscriber.findById(req.params.id);
  if (!subscriber) throw ApiError.notFound('Subscriber not found');
  subscriber.status = status;
  if (status === 'subscribed') {
    subscriber.subscribedAt = new Date();
    subscriber.unsubscribedAt = undefined;
  } else {
    subscriber.unsubscribedAt = new Date();
  }
  await subscriber.save();
  res.json({ success: true, message: status === 'subscribed' ? 'Subscriber re-activated' : 'Subscriber unsubscribed', data: subscriber });
});

export const deleteSubscriber = asyncHandler(async (req, res) => {
  const subscriber = await Subscriber.findByIdAndDelete(req.params.id);
  if (!subscriber) throw ApiError.notFound('Subscriber not found');
  res.json({ success: true, message: 'Subscriber deleted', data: { id: subscriber.id } });
});

// ---------- Admin: campaigns ----------

export const listCampaigns = asyncHandler(async (req, res) => {
  const { items, pagination } = await paginate(NewsletterCampaign, req.query, { defaultSort: '-createdAt' });
  const subscribed = await Subscriber.countDocuments({ status: 'subscribed' });
  res.json({ success: true, data: items, pagination, meta: { subscribed, email: emailStatus() } });
});

const loadCampaignInput = async (body) => {
  const data = pickFields(body, ['subject', 'content', 'announcement']);
  if (!data.subject?.trim()) throw ApiError.badRequest('Subject is required', { subject: 'Subject is required' });
  if (!data.content?.trim()) throw ApiError.badRequest('Content is required', { content: 'Content is required' });
  let announcement = null;
  if (data.announcement) {
    if (!mongoose.isValidObjectId(data.announcement)) throw ApiError.badRequest('Invalid announcement');
    announcement = await Announcement.findById(data.announcement);
    if (!announcement) throw ApiError.notFound('Announcement not found');
  }
  return { subject: String(data.subject).trim().slice(0, 160), content: String(data.content).trim().slice(0, 20000), announcement };
};

const buildEmail = ({ subject, content, announcement }, subscriberId) =>
  newsletterEmail({
    subject,
    content,
    subscriberId,
    imageUrl: announcement?.imageUrl,
    ctaLabel: announcement?.ctaLabel,
    ctaUrl: announcement?.ctaUrl,
  });

// Sends a preview to the signed-in admin's own address
export const sendTest = asyncHandler(async (req, res) => {
  if (!isEmailConfigured()) throw ApiError.badRequest('Email service is not configured on the server');
  const input = await loadCampaignInput(req.body);
  const message = buildEmail(input, 'preview');
  try {
    await sendEmail({ to: req.admin.email, ...message, subject: `[Test] ${message.subject}` });
  } catch (err) {
    throw new ApiError(502, err.message);
  }
  res.json({ success: true, message: `Test email sent to ${req.admin.email}` });
});

const CONCURRENCY = 5;

// Delivers a campaign in the background, a few emails at a time, recording progress
const deliver = async (campaign, input) => {
  let delivered = 0;
  let failed = 0;
  let lastError = '';
  try {
    const cursor = Subscriber.find({ status: 'subscribed' }).select('_id email').cursor();
    let batch = [];
    const flush = async () => {
      const results = await Promise.allSettled(
        batch.map((s) => sendEmail({ to: s.email, ...buildEmail(input, s.id) }))
      );
      results.forEach((r) => {
        if (r.status === 'fulfilled') delivered += 1;
        else {
          failed += 1;
          lastError = r.reason?.message || 'Unknown error';
        }
      });
      batch = [];
      await NewsletterCampaign.updateOne({ _id: campaign._id }, { delivered, failed, lastError });
    };
    for await (const s of cursor) {
      batch.push(s);
      if (batch.length >= CONCURRENCY) await flush();
    }
    if (batch.length) await flush();
    await NewsletterCampaign.updateOne(
      { _id: campaign._id },
      { status: delivered === 0 && failed > 0 ? 'failed' : 'sent', delivered, failed, lastError, completedAt: new Date() }
    );
  } catch (err) {
    console.error('Newsletter campaign failed:', err);
    await NewsletterCampaign.updateOne(
      { _id: campaign._id },
      { status: 'failed', delivered, failed, lastError: err.message, completedAt: new Date() }
    ).catch(() => {});
  }
};

export const sendCampaign = asyncHandler(async (req, res) => {
  if (!isEmailConfigured()) throw ApiError.badRequest('Email service is not configured on the server');
  const input = await loadCampaignInput(req.body);

  // A send interrupted by a server restart never finishes: release it after 30 idle minutes
  await NewsletterCampaign.updateMany(
    { status: 'sending', updatedAt: { $lt: new Date(Date.now() - 30 * 60 * 1000) } },
    { status: 'failed', lastError: 'Interrupted (server restarted)', completedAt: new Date() }
  );
  if (await NewsletterCampaign.exists({ status: 'sending' })) {
    throw new ApiError(409, 'Another newsletter is still being sent. Please wait for it to finish.');
  }
  const recipients = await Subscriber.countDocuments({ status: 'subscribed' });
  if (!recipients) throw ApiError.badRequest('There are no confirmed subscribers yet');

  const campaign = await NewsletterCampaign.create({
    subject: input.subject,
    content: input.content,
    announcement: input.announcement?._id || null,
    recipients,
    sentBy: req.admin._id,
  });
  deliver(campaign, input);
  res.status(202).json({ success: true, message: `Sending to ${recipients} subscriber(s)…`, data: campaign });
});
