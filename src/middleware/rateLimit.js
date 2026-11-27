import rateLimit from 'express-rate-limit';
import env from '../config/env.js';

export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { success: false, message: 'Too many login attempts, try again in 15 minutes' },
});

// Public form submissions (contact + job applications)
export const formLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { success: false, message: 'Too many submissions, please try again later' },
});

// Registration OTP verify / resend (per IP). Per-OTP attempt cap is enforced in the controller too.
export const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { success: false, message: 'Too many verification attempts, try again in 15 minutes' },
});

// AI assistant: messages sent to the model (per IP). A per-visitor daily cap is applied too.
export const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: env.ai.chatRequestsPerMinute,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { success: false, message: 'You are sending messages too quickly. Please wait a moment.' },
});

// AI assistant: messages per visitor / logged-in user, whatever IP they come from.
// Runs after requireVisitor, optionalUser and visitorCookie.
export const chatIdentityLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: env.ai.chatIdentityRequestsPerMinute,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => (req.user ? `u:${req.user._id}` : `v:${req.visitorId || req.visitorHash}`),
  message: { success: false, code: 'rate_limited', message: 'You are sending messages too quickly. Please wait a moment.' },
});

// AI assistant: email verification code requests / checks (per IP). Per-address and
// per-code limits are applied in ai/chatAccess.js too.
export const chatOtpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: env.ai.chatOtpRequestsPer15Min,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { success: false, message: 'Too many verification attempts, try again in 15 minutes' },
});

// AI assistant: anonymous chat sessions created (per IP)
export const chatSessionLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: env.ai.sessionsPerHour,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { success: false, message: 'Too many chat sessions, please try again later' },
});

// Admin AI tools that call the provider (connection tests, model lists, test chat)
export const aiAdminLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { success: false, message: 'Too many AI requests, please wait a minute' },
});

// Newsletter subscribe / verify / unsubscribe (per IP)
export const newsletterLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests, please try again in a few minutes' },
});

// Cookie consent banner save / withdraw (per IP)
export const cookieConsentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests, please try again in a few minutes' },
});
