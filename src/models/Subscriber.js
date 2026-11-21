import mongoose from 'mongoose';
import { toJSONPlugin } from './plugins.js';

export const SUBSCRIBER_STATUSES = ['pending', 'subscribed', 'unsubscribed'];

// Newsletter subscriber (kept separate from announcements and from registered users)
const subscriberSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: [true, 'Email is required'],
      unique: true,
      lowercase: true,
      trim: true,
      maxlength: 254,
      match: [/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/, 'Enter a valid email address'],
    },
    status: { type: String, enum: SUBSCRIBER_STATUSES, default: 'pending' },
    source: { type: String, trim: true, maxlength: 40, default: 'footer' },
    // SHA-256 of the email verification token (the raw token is only ever in the email)
    verifyTokenHash: { type: String, select: false },
    verifyExpires: { type: Date, select: false },
    verificationSentAt: { type: Date, select: false },
    subscribedAt: Date,
    unsubscribedAt: Date,
    ip: { type: String, select: false },
  },
  { timestamps: true }
);

subscriberSchema.index({ status: 1, createdAt: -1 });

subscriberSchema.plugin(toJSONPlugin);

export default mongoose.model('Subscriber', subscriberSchema);
