import crypto from 'crypto';
import env from '../config/env.js';
import { ChatOtpChallenge, ChatVerifiedSession } from '../models/ChatVerification.js';
import ApiError from '../utils/ApiError.js';
import { chatVerificationOtpEmail, hashToken, isEmailConfigured, sendEmail } from '../services/emailService.js';

// Who may ask job questions in the AI assistant, worked out on the server for every request:
//  - a logged-in website account (verified JWT, see optionalUser), or
//  - a visitor whose chat session proved ownership of an email with a one-time code.
// Email verification is tied to the chat session token (an unguessable secret the browser
// already sends), so it needs no extra cookie and does not change the question quota.

const OTP_TTL_MIN = env.ai.chatOtpTtlMinutes;
const MAX_ATTEMPTS = 5;
const RESEND_AFTER_S = 60;
const MAX_SENDS_PER_HOUR = 5;
const VERIFIED_DAYS = 30;
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** @returns {Promise<{ method: 'account'|'email', email, user?, name? } | null>} */
export const resolveChatAccess = async (req) => {
  if (req.user) return { method: 'account', email: req.user.email, name: req.user.name, phone: req.user.phone, user: req.user._id };
  if (!req.visitorHash) return null;
  const verified = await ChatVerifiedSession.findOne({ visitorHash: req.visitorHash, expireAt: { $gt: new Date() } }).lean();
  return verified ? { method: 'email', email: verified.email } : null;
};

// Delivery is replaceable in tests (no real emails are sent there)
let deliver = async ({ email, otp }) => sendEmail({ to: email, ...chatVerificationOtpEmail({ otp, minutes: OTP_TTL_MIN }) });
export const setOtpDelivery = (fn) => {
  deliver = fn || deliver;
};

const newOtp = () => crypto.randomInt(0, 1000000).toString().padStart(6, '0');
const maskEmail = (e) => e.replace(/^(.).*?(@.*)$/, '$1***$2');

export const requestEmailOtp = async ({ visitorHash, email }) => {
  if (!isEmailConfigured() && env.nodeEnv !== 'test') {
    throw new ApiError(503, 'Email verification is not available right now. Please log in instead.');
  }
  const now = new Date();
  let challenge = await ChatOtpChallenge.findOne({ visitorHash, email });
  if (challenge) {
    const waited = (now - challenge.lastSentAt) / 1000;
    if (waited < RESEND_AFTER_S) {
      throw new ApiError(429, `Please wait ${Math.ceil(RESEND_AFTER_S - waited)} seconds before requesting another code.`);
    }
    if (challenge.sendCount >= MAX_SENDS_PER_HOUR) throw new ApiError(429, 'Too many codes requested. Please try again later.');
  }
  // Across all chat sessions, at most a few codes per address per hour (no inbox flooding)
  const recentForEmail = await ChatOtpChallenge.aggregate([
    { $match: { email, createdAt: { $gte: new Date(now - 60 * 60 * 1000) } } },
    { $group: { _id: null, sends: { $sum: '$sendCount' } } },
  ]);
  if ((recentForEmail[0]?.sends || 0) >= MAX_SENDS_PER_HOUR * 2) throw new ApiError(429, 'Too many codes requested. Please try again later.');

  const otp = newOtp();
  const fields = { otpHash: hashToken(otp), otpExpiresAt: new Date(now.getTime() + OTP_TTL_MIN * 60 * 1000), attempts: 0, lastSentAt: now };
  if (challenge) {
    challenge.set({ ...fields, sendCount: challenge.sendCount + 1 });
  } else {
    challenge = new ChatOtpChallenge({ visitorHash, email, ...fields });
  }
  await challenge.save();
  try {
    await deliver({ email, otp });
  } catch (err) {
    console.error(`[chat-otp] delivery failed to=${maskEmail(email)}: ${err.message}`);
    throw new ApiError(502, 'We could not send the code. Please check the address or try again later.');
  }
  return { email, expiresInSeconds: OTP_TTL_MIN * 60, resendAfterSeconds: RESEND_AFTER_S };
};

export const confirmEmailOtp = async ({ visitorHash, email, otp }) => {
  const challenge = await ChatOtpChallenge.findOne({ visitorHash, email });
  if (!challenge) throw ApiError.badRequest('Request a verification code first.');
  if (challenge.attempts >= MAX_ATTEMPTS) throw new ApiError(429, 'Too many incorrect attempts. Request a new code.');
  if (challenge.otpExpiresAt < new Date()) throw ApiError.badRequest('This code has expired. Request a new one.');

  // Count the attempt atomically before comparing, so parallel guesses cannot exceed the cap
  const counted = await ChatOtpChallenge.findOneAndUpdate(
    { _id: challenge._id, attempts: { $lt: MAX_ATTEMPTS } },
    { $inc: { attempts: 1 } },
    { new: true }
  );
  if (!counted) throw new ApiError(429, 'Too many incorrect attempts. Request a new code.');
  const ok = crypto.timingSafeEqual(Buffer.from(hashToken(otp)), Buffer.from(counted.otpHash));
  if (!ok) {
    const left = MAX_ATTEMPTS - counted.attempts;
    throw ApiError.badRequest(left > 0 ? `Incorrect code. ${left} attempt${left === 1 ? '' : 's'} left.` : 'Too many incorrect attempts. Request a new code.');
  }

  await counted.deleteOne();
  await ChatVerifiedSession.findOneAndUpdate(
    { visitorHash },
    { email, verifiedAt: new Date(), expireAt: new Date(Date.now() + VERIFIED_DAYS * 24 * 60 * 60 * 1000) },
    { upsert: true }
  );
  return { method: 'email', email };
};

export const revokeEmailVerification = (visitorHash) => ChatVerifiedSession.deleteOne({ visitorHash });
