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

// AI assistant: messages sent to the model (per IP). A per-visitor daily cap is applied too.
export const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: env.ai.chatRequestsPerMinute,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { success: false, message: 'You are sending messages too quickly. Please wait a moment.' },
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
