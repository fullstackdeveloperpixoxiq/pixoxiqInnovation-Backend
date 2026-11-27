import mongoose from 'mongoose';

// Email ownership for the AI assistant's job enquiries, without creating an account.
//
// ChatOtpChallenge: a pending one-time code, bound to the chat session that asked for it.
//   The code is stored only as a SHA-256 hash and expires after a few minutes.
// ChatVerifiedSession: a chat session (by its token hash) whose visitor proved they own an
//   email address. It does not change the visitor's question quota.

const otpChallengeSchema = new mongoose.Schema(
  {
    visitorHash: { type: String, required: true },
    email: { type: String, required: true, lowercase: true, trim: true, maxlength: 254 },
    otpHash: { type: String, required: true },
    otpExpiresAt: { type: Date, required: true },
    attempts: { type: Number, default: 0 },
    sendCount: { type: Number, default: 1 },
    lastSentAt: { type: Date, required: true },
    // The whole challenge (and its send counter) is dropped an hour after it was started
    expireAt: { type: Date, default: () => new Date(Date.now() + 60 * 60 * 1000), index: { expires: 0 } },
  },
  { timestamps: true }
);
otpChallengeSchema.index({ visitorHash: 1, email: 1 }, { unique: true });
otpChallengeSchema.index({ email: 1, createdAt: -1 });

const verifiedSessionSchema = new mongoose.Schema(
  {
    visitorHash: { type: String, required: true, unique: true },
    email: { type: String, required: true, lowercase: true, trim: true, maxlength: 254 },
    verifiedAt: { type: Date, default: Date.now },
    expireAt: { type: Date, required: true, index: { expires: 0 } },
  },
  { timestamps: true }
);
verifiedSessionSchema.index({ email: 1 });

export const ChatOtpChallenge = mongoose.model('ChatOtpChallenge', otpChallengeSchema);
export const ChatVerifiedSession = mongoose.model('ChatVerifiedSession', verifiedSessionSchema);
