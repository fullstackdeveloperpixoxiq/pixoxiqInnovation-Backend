import CookieConsent, { CONSENT_DECISIONS } from '../models/CookieConsent.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import { paginate, buildListQuery } from '../utils/queryBuilder.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_RE = /^[+\d\s()-]{6,20}$/;
const VISITOR_RE = /^[A-Za-z0-9_-]{8,64}$/;
const PREF_KEYS = ['functional', 'analytics', 'marketing'];

const str = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);

const LIST_OPTIONS = {
  searchFields: ['email', 'name', 'company', 'visitorId'],
  filterFields: ['decision', 'marketingOptIn'],
  defaultSort: '-createdAt',
};

const checkVisitorId = (id) => {
  if (typeof id !== 'string' || !VISITOR_RE.test(id)) throw ApiError.badRequest('Invalid visitor id');
  return id;
};

// ---------- Public ----------

// Body: { visitorId, decision, preferences?, email?, name?, phone?, company?, marketingOptIn?,
//         policyVersion?, page?, referrer?, language?, timezone?, screen?, website? (honeypot) }
export const saveConsent = asyncHandler(async (req, res) => {
  if (req.body.website) return res.status(201).json({ success: true, message: 'Cookie preferences saved' });

  const visitorId = checkVisitorId(req.body.visitorId);
  const { decision } = req.body;
  if (!CONSENT_DECISIONS.includes(decision)) throw ApiError.badRequest('Invalid consent decision');

  const raw = req.body.preferences && typeof req.body.preferences === 'object' ? req.body.preferences : {};
  const preferences = { necessary: true };
  PREF_KEYS.forEach((k) => {
    if (decision === 'accepted') preferences[k] = true;
    else if (decision === 'rejected') preferences[k] = false;
    else preferences[k] = raw[k] === true;
  });

  const email = str(req.body.email, 254)?.toLowerCase();
  if (email && !EMAIL_RE.test(email)) throw ApiError.badRequest('Enter a valid email address');
  const phone = str(req.body.phone, 20);
  if (phone && !PHONE_RE.test(phone)) throw ApiError.badRequest('Enter a valid phone number');

  const update = {
    decision,
    preferences,
    policyVersion: str(req.body.policyVersion, 20) || '1.0',
    page: str(req.body.page, 500),
    referrer: str(req.body.referrer, 500),
    language: str(req.body.language, 20),
    timezone: str(req.body.timezone, 60),
    screen: str(req.body.screen, 20),
    userAgent: str(req.get('user-agent'), 500),
    ip: req.ip,
    consentedAt: new Date(),
  };
  // Contact details only overwrite when provided, so changing cookie choices later keeps them
  const contact = { email, phone, name: str(req.body.name, 100), company: str(req.body.company, 120) };
  Object.entries(contact).forEach(([k, v]) => {
    if (v) update[k] = v;
  });
  if (email) update.marketingOptIn = req.body.marketingOptIn === true;
  if (req.user?._id) update.user = req.user._id;

  const consent = await CookieConsent.findOneAndUpdate(
    { visitorId },
    { $set: update, $unset: { withdrawnAt: 1 } },
    { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
  );

  res.status(201).json({
    success: true,
    message: 'Cookie preferences saved',
    data: { visitorId: consent.visitorId, decision: consent.decision, preferences: consent.preferences },
  });
});

export const getConsent = asyncHandler(async (req, res) => {
  const visitorId = checkVisitorId(req.params.visitorId);
  const consent = await CookieConsent.findOne({ visitorId, withdrawnAt: { $exists: false } }).select(
    'visitorId decision preferences policyVersion consentedAt'
  );
  if (!consent) throw ApiError.notFound('No consent recorded');
  res.json({ success: true, data: consent });
});

// Withdraw consent: removes personal details, keeps only necessary cookies
export const withdrawConsent = asyncHandler(async (req, res) => {
  const visitorId = checkVisitorId(req.params.visitorId);
  await CookieConsent.updateOne(
    { visitorId },
    {
      $set: {
        decision: 'rejected',
        preferences: { necessary: true, functional: false, analytics: false, marketing: false },
        marketingOptIn: false,
        withdrawnAt: new Date(),
      },
      $unset: { email: 1, name: 1, phone: 1, company: 1, ip: 1, user: 1 },
    }
  );
  res.json({ success: true, message: 'Consent withdrawn and personal details removed' });
});

// ---------- Admin ----------

export const listConsents = asyncHandler(async (req, res) => {
  const { items, pagination } = await paginate(CookieConsent, req.query, LIST_OPTIONS);
  const [grouped, withEmail] = await Promise.all([
    CookieConsent.aggregate([{ $group: { _id: '$decision', count: { $sum: 1 } } }]),
    CookieConsent.countDocuments({ email: { $exists: true } }),
  ]);
  const counts = Object.fromEntries(CONSENT_DECISIONS.map((d) => [d, 0]));
  grouped.forEach((g) => {
    counts[g._id] = g.count;
  });
  res.json({ success: true, data: items, pagination, counts: { ...counts, withEmail } });
});

const csvCell = (value) => {
  let s = value === null || value === undefined ? '' : String(value);
  // Neutralise spreadsheet formulas (CSV injection)
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export const exportConsents = asyncHandler(async (req, res) => {
  const { filter } = buildListQuery(req.query, LIST_OPTIONS);
  const rows = await CookieConsent.find(filter).sort('-createdAt').limit(100000).lean();
  const iso = (d) => (d ? new Date(d).toISOString() : '');
  const header = [
    'Visitor ID', 'Decision', 'Functional', 'Analytics', 'Marketing', 'Email', 'Name', 'Phone', 'Company',
    'Marketing opt-in', 'Policy', 'Page', 'Language', 'Timezone', 'Consented at', 'Withdrawn at',
  ];
  const lines = [
    header.join(','),
    ...rows.map((r) =>
      [
        r.visitorId, r.decision, r.preferences?.functional, r.preferences?.analytics, r.preferences?.marketing,
        r.email, r.name, r.phone, r.company, r.marketingOptIn, r.policyVersion, r.page, r.language, r.timezone,
        iso(r.consentedAt), iso(r.withdrawnAt),
      ].map(csvCell).join(',')
    ),
  ];
  res.set({
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="cookie-consents-${new Date().toISOString().slice(0, 10)}.csv"`,
  });
  res.send(`﻿${lines.join('\n')}`);
});

export const deleteConsent = asyncHandler(async (req, res) => {
  const consent = await CookieConsent.findByIdAndDelete(req.params.id);
  if (!consent) throw ApiError.notFound('Consent record not found');
  res.json({ success: true, message: 'Consent record deleted', data: { id: consent.id } });
});
