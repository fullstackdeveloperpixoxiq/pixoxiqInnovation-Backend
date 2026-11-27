import mongoose from 'mongoose';
import { toJSONPlugin } from './plugins.js';

// Daily AI question quota counters (one document per subject per IST day).
//
// subjectKey identifies who is counted, never in a reversible form for visitors:
//   u:<userId>          logged-in website account (verified JWT, never a client-supplied id)
//   v:<sha256(cookie)>  anonymous visitor cookie (pxq_vid)
//   s:<sha256(token)>   anonymous chat session token (X-Chat-Session)
//   ip:<hmac(ip)>       per-network ceiling for anonymous visitors (abuse protection)
//
// `isPrimary` marks the counter a question is attributed to for analytics (the user, or the
// visitor cookie / session when there is no cookie). The other counters are guards that stop
// visitors from getting a fresh quota by clearing one kind of browser storage.
//
// Counters are only changed with atomic conditional updates (see ai/quotaService.js); the
// unique (subjectKey, day) index makes concurrent first requests of the day safe.
const chatUsageSchema = new mongoose.Schema(
  {
    subjectKey: { type: String, required: true },
    subjectType: { type: String, enum: ['user', 'visitor', 'session', 'ip'], required: true },
    authenticated: { type: Boolean, default: false },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    isPrimary: { type: Boolean, default: false },
    // Calendar day in Asia/Kolkata, YYYY-MM-DD
    day: { type: String, required: true },
    used: { type: Number, default: 0, min: 0 },
    // Limit in force at the last update and what was left of it (informational; enforcement
    // always uses the current setting)
    limit: { type: Number, default: 0 },
    remaining: { type: Number, default: 0 },
    // Answers that failed with a server/provider error (their question was refunded)
    failed: { type: Number, default: 0 },
    answered: { type: Number, default: 0 },
    inputTokens: { type: Number, default: 0 },
    outputTokens: { type: Number, default: 0 },
    // Logged-in users: anonymous questions asked earlier the same day, carried into `used` at
    // login so signing in never grants extra visitor questions. carriedFrom: { <anonKey>: n }
    carriedOver: { type: Number, default: 0 },
    carriedFrom: { type: mongoose.Schema.Types.Mixed, default: undefined },
    createdAt: { type: Date },
    updatedAt: { type: Date },
  },
  // Timestamps are written by the atomic update pipelines themselves
  { timestamps: false, minimize: true }
);

chatUsageSchema.index({ subjectKey: 1, day: 1 }, { unique: true });
chatUsageSchema.index({ day: 1, isPrimary: 1, authenticated: 1 });
chatUsageSchema.index({ user: 1, day: -1 }, { partialFilterExpression: { user: { $type: 'objectId' } } });
// Old counters are only needed for analytics
chatUsageSchema.index({ createdAt: 1 }, { expireAfterSeconds: 400 * 24 * 60 * 60 });

chatUsageSchema.plugin(toJSONPlugin);

export default mongoose.model('ChatUsage', chatUsageSchema);
