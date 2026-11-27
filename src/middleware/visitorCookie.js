import crypto from 'crypto';
import env from '../config/env.js';

// Persistent anonymous visitor id for the AI assistant's daily question quota.
//
// The id is random, signed with a key derived from JWT_SECRET (so ids cannot be made up) and
// kept in an HttpOnly cookie that page scripts cannot read or change. Only its SHA-256 hash is
// ever stored. In production the website and the API are on different sites, so the cookie
// is SameSite=None; Secure; Partitioned (CHIPS), which keeps it working where third-party
// cookies are being phased out. Where a browser still refuses it, quotas fall back to the
// chat session token and the per-IP ceiling (see ai/quotaService.js).

export const VISITOR_COOKIE = 'pxq_vid';
const ID_RE = /^[A-Za-z0-9_-]{32}$/;
const MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;

const signingKey = crypto.createHmac('sha256', env.jwtSecret).update('chat-visitor-cookie-v1').digest();
const sign = (id) => crypto.createHmac('sha256', signingKey).update(id).digest('base64url');

const readCookie = (req, name) => {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx !== -1 && part.slice(0, idx).trim() === name) {
      try {
        return decodeURIComponent(part.slice(idx + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
};

/** Returns the visitor id from a signed cookie value, or null when missing/forged */
export const verifyVisitorCookie = (value) => {
  if (!value) return null;
  const [id, signature] = String(value).split('.');
  if (!id || !signature || !ID_RE.test(id)) return null;
  const expected = Buffer.from(sign(id));
  const given = Buffer.from(signature);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given) ? id : null;
};

export const createVisitorCookieValue = () => {
  const id = crypto.randomBytes(24).toString('base64url');
  return { id, value: `${id}.${sign(id)}` };
};

const cookieOptions = () => ({
  httpOnly: true,
  secure: env.isProd,
  sameSite: env.isProd ? 'none' : 'lax',
  partitioned: env.isProd,
  maxAge: MAX_AGE_MS,
  path: '/api/public/chat',
});

// Sets req.visitorId, issuing the cookie when it is missing or invalid
export const visitorCookie = (req, res, next) => {
  let id = verifyVisitorCookie(readCookie(req, VISITOR_COOKIE));
  if (!id) {
    const created = createVisitorCookieValue();
    id = created.id;
    res.cookie(VISITOR_COOKIE, created.value, cookieOptions());
  }
  req.visitorId = id;
  next();
};
