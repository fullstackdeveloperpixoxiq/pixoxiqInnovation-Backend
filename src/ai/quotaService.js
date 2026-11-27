import crypto from 'crypto';
import env from '../config/env.js';
import ChatUsage from '../models/ChatUsage.js';
import { sha256 } from './crypto.js';
import { logAi } from './logger.js';

// Daily AI question quotas, enforced only here on the server.
//
//  - Logged-in users: settings.userDailyQuestionLimit (default 100), counted on their user id.
//  - Visitors: settings.visitorDailyQuestionLimit (default 10), counted on BOTH the visitor
//    cookie and the chat session token, plus a per-IP ceiling (visitorIpDailyLimit), so
//    clearing one kind of storage or refreshing never yields a fresh quota.
//  - Quotas reset at midnight Asia/Kolkata.
//
// A question is reserved atomically before the AI provider is called and refunded if the
// answer fails with a server/provider error. Counts sent by the browser are never used.

export const QUOTA_TIMEZONE = 'Asia/Kolkata';
// Asia/Kolkata is UTC+05:30 all year round (no daylight saving time)
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

let now = () => new Date();
/** Test hook: replace the clock (pass null to restore) */
export const setQuotaClock = (fn) => {
  now = fn || (() => new Date());
};

/** Current quota day (YYYY-MM-DD in IST) and the instant it ends (next IST midnight) */
export const quotaDay = (at = now()) => {
  const shifted = new Date(at.getTime() + IST_OFFSET_MS);
  const day = shifted.toISOString().slice(0, 10);
  const resetsAt = new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate() + 1) - IST_OFFSET_MS);
  return { day, resetsAt };
};

/** IST day key `daysAgo` days before `day` */
export const shiftDay = (day, daysAgo) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().slice(0, 10);
};

// IPs are hashed with a server secret: the IPv4 space is small enough to reverse a plain hash
const ipSecret = crypto.createHmac('sha256', env.jwtSecret).update('chat-quota-ip-v1').digest();
const hashIp = (ip) => crypto.createHmac('sha256', ipSecret).update(String(ip || 'unknown')).digest('hex');

/** Short, non-reversible label for admins (same idea as ChatConversation.visitorTag) */
export const subjectTag = (subjectKey) => String(subjectKey).split(':')[1]?.slice(0, 8) || '';

// The unique (subjectKey, day) index must exist before the first reservation, otherwise two
// concurrent first requests of the day could create duplicate counters
let indexesReady = null;
const ensureIndexes = () => {
  if (!indexesReady) {
    indexesReady = ChatUsage.init().catch((err) => {
      indexesReady = null;
      throw err;
    });
  }
  return indexesReady;
};

/**
 * Works out which counters apply to this request. Requires requireVisitor (req.visitorHash),
 * optionalUser (req.user, from a verified JWT) and visitorCookie (req.visitorId).
 */
export const buildQuotaPlan = (req, settings) => {
  const { day, resetsAt } = quotaDay();
  const anonKeys = [];
  if (req.visitorId) anonKeys.push({ key: `v:${sha256(req.visitorId)}`, type: 'visitor' });
  if (req.visitorHash) anonKeys.push({ key: `s:${req.visitorHash}`, type: 'session' });

  if (req.user) {
    const limit = settings.userDailyQuestionLimit;
    return {
      day,
      resetsAt,
      authenticated: true,
      limit,
      counters: [{ key: `u:${req.user._id}`, type: 'user', limit, user: req.user._id, primary: true }],
      anonKeys,
    };
  }

  const limit = settings.visitorDailyQuestionLimit;
  const counters = anonKeys.map((k, i) => ({ ...k, limit, primary: i === 0 }));
  if (settings.visitorIpDailyLimit > 0) {
    counters.push({ key: `ip:${hashIp(req.ip)}`, type: 'ip', limit: settings.visitorIpDailyLimit, primary: false });
  }
  return { day, resetsAt, authenticated: false, limit, counters, anonKeys, authenticatedLimit: settings.userDailyQuestionLimit };
};

// ---------- Atomic counter updates ----------

const usedPlus = (n) => ({ $add: [{ $ifNull: ['$used', 0] }, n] });

// Fields written on every update. Values go through $literal so no string is ever read as an
// aggregation expression.
const identityFields = (plan, c) => ({
  subjectType: { $literal: c.type },
  authenticated: { $literal: plan.authenticated },
  user: { $literal: c.user || null },
  isPrimary: { $literal: Boolean(c.primary) },
  createdAt: { $ifNull: ['$createdAt', '$$NOW'] },
  updatedAt: '$$NOW',
});

/** +1 on the counter if it is below its limit. Returns false when the limit is reached. */
const incrementIfBelow = async (plan, c) => {
  const filter = { subjectKey: c.key, day: plan.day, used: { $lt: c.limit } };
  const update = [
    {
      $set: {
        ...identityFields(plan, c),
        used: usedPlus(1),
        limit: { $literal: c.limit },
        remaining: { $max: [0, { $subtract: [c.limit, usedPlus(1)] }] },
      },
    },
  ];
  try {
    const doc = await ChatUsage.collection.findOneAndUpdate(filter, update, { upsert: true, returnDocument: 'after' });
    return Boolean(doc);
  } catch (err) {
    if (err.code !== 11000) throw err;
    // The counter exists: either it is at its limit (the filter did not match, so the upsert
    // tried to insert a duplicate) or another request created it at the same moment. Retry
    // once without upsert to tell the two apart.
    const doc = await ChatUsage.collection.findOneAndUpdate(filter, update, { returnDocument: 'after' });
    return Boolean(doc);
  }
};

/** -1 on the counter (never below 0). `failed` also counts a failed answer on it. */
const decrement = (plan, c, { failed = false } = {}) =>
  ChatUsage.collection.updateOne({ subjectKey: c.key, day: plan.day, used: { $gt: 0 } }, [
    {
      $set: {
        used: usedPlus(-1),
        remaining: { $max: [0, { $subtract: ['$limit', usedPlus(-1)] }] },
        updatedAt: '$$NOW',
        ...(failed ? { failed: { $add: [{ $ifNull: ['$failed', 0] }, 1] } } : {}),
      },
    },
  ]);

/**
 * Logged-in users: anonymous questions asked today in this browser are carried into the user
 * counter, so logging in never hands out extra questions on top of the visitor quota (and
 * logging out again finds the visitor counters unchanged). Only the not-yet-carried part is
 * added, guarded by an optimistic check so concurrent requests cannot add it twice.
 */
export const carryOverAnonymousUsage = async (plan) => {
  if (!plan.authenticated || !plan.anonKeys.length) return;
  await ensureIndexes();
  const userCounter = plan.counters[0];
  const groupKey = plan.anonKeys[0].key;
  const [anonDocs, userDoc] = await Promise.all([
    ChatUsage.find({ day: plan.day, subjectKey: { $in: plan.anonKeys.map((k) => k.key) } }, 'used').lean(),
    ChatUsage.findOne({ subjectKey: userCounter.key, day: plan.day }, 'carriedFrom').lean(),
  ]);
  const anonUsed = Math.max(0, ...anonDocs.map((d) => d.used || 0));
  const already = userDoc?.carriedFrom?.[groupKey] || 0;
  const delta = anonUsed - already;
  if (delta <= 0) return;

  const markerPath = `carriedFrom.${groupKey}`;
  try {
    await ChatUsage.collection.updateOne(
      { subjectKey: userCounter.key, day: plan.day, [markerPath]: already ? already : { $exists: false } },
      [
        {
          $set: {
            ...identityFields(plan, userCounter),
            used: usedPlus(delta),
            carriedOver: { $add: [{ $ifNull: ['$carriedOver', 0] }, delta] },
            [markerPath]: { $literal: anonUsed },
            limit: { $literal: userCounter.limit },
            remaining: { $max: [0, { $subtract: [userCounter.limit, usedPlus(delta)] }] },
          },
        },
      ],
      { upsert: !userDoc }
    );
  } catch (err) {
    // A concurrent request carried it over first
    if (err.code !== 11000) throw err;
  }
};

/** Current usage for display: the tightest of the applicable counters */
export const getQuotaUsage = async (plan) => {
  const docs = await ChatUsage.find({ day: plan.day, subjectKey: { $in: plan.counters.map((c) => c.key) } }, 'subjectKey used').lean();
  const usedBy = Object.fromEntries(docs.map((d) => [d.subjectKey, d.used || 0]));
  const remaining = Math.max(0, Math.min(plan.limit, ...plan.counters.map((c) => c.limit - (usedBy[c.key] || 0))));
  return {
    limit: plan.limit,
    used: plan.limit - remaining,
    remaining,
    resetsAt: plan.resetsAt.toISOString(),
    timezone: QUOTA_TIMEZONE,
    authenticated: plan.authenticated,
    // Visitors: what logging in would give them (shown in the sign-up prompt)
    ...(plan.authenticated ? {} : { authenticatedLimit: plan.authenticatedLimit }),
  };
};

// One warning per network per day when the per-IP ceiling blocks visitors
const ipWarnings = { day: '', seen: new Set() };
const warnIpCeiling = async (plan, counter) => {
  if (ipWarnings.day !== plan.day) {
    ipWarnings.day = plan.day;
    ipWarnings.seen.clear();
  }
  if (ipWarnings.seen.has(counter.key)) return;
  ipWarnings.seen.add(counter.key);
  await logAi({
    level: 'warn',
    source: 'quota',
    message: `Network ${subjectTag(counter.key)} reached the visitor limit of ${counter.limit} questions per IP today. Further visitor questions from it are rejected until midnight IST.`,
    code: 'ip_daily_limit',
    context: { day: plan.day, network: subjectTag(counter.key) },
  });
};

/**
 * Reserves one question on every applicable counter, all or nothing. Concurrent requests can
 * never exceed a limit: each increment only succeeds while the counter is below it.
 * @returns {{ ok: true, reservation, usage } | { ok: false, usage, blockedBy }}
 */
export const reserveQuestion = async (plan) => {
  await ensureIndexes();
  await carryOverAnonymousUsage(plan);
  const reserved = [];
  for (const counter of plan.counters) {
    // eslint-disable-next-line no-await-in-loop
    const ok = await incrementIfBelow(plan, counter);
    if (!ok) {
      await Promise.all(reserved.map((c) => decrement(plan, c)));
      if (counter.type === 'ip') warnIpCeiling(plan, counter).catch(() => {});
      return { ok: false, blockedBy: counter.type, usage: await getQuotaUsage(plan) };
    }
    reserved.push(counter);
  }
  return { ok: true, reservation: { plan, counters: reserved, settled: false }, usage: await getQuotaUsage(plan) };
};

/**
 * Gives the question back (server/provider error or the request failed before reaching the
 * AI). Uses the reservation's own day, so a request that crosses midnight refunds the right
 * counter. Safe to call twice.
 */
export const refundQuestion = async (reservation, { failed = false } = {}) => {
  if (!reservation || reservation.settled) return;
  reservation.settled = true;
  const { plan, counters } = reservation;
  await Promise.all(counters.map((c) => decrement(plan, c, { failed: failed && c.primary })));
};

/** Records a delivered answer (and its token usage) on the primary counter */
export const recordAnswer = async (reservation, usage) => {
  if (!reservation || reservation.settled) return;
  reservation.settled = true;
  const primary = reservation.counters.find((c) => c.primary);
  if (!primary) return;
  await ChatUsage.updateOne(
    { subjectKey: primary.key, day: reservation.plan.day },
    { $inc: { answered: 1, inputTokens: usage?.inputTokens || 0, outputTokens: usage?.outputTokens || 0 } }
  );
};

/** Seconds until the quota resets (Retry-After header) */
export const secondsUntilReset = (plan) => Math.max(1, Math.ceil((plan.resetsAt.getTime() - now().getTime()) / 1000));
