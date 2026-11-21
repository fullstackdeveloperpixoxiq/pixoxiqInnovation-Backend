import mongoose from 'mongoose';

// Sign-up awaiting email OTP verification. The User is only created once the OTP is confirmed.
// Password and OTP are stored hashed; documents auto-expire via the TTL index.
const pendingRegistrationSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: { type: String, required: true, trim: true, maxlength: 100 },
    phone: { type: String, required: true, trim: true },
    company: { type: String, trim: true, maxlength: 120, default: '' },
    city: { type: String, trim: true, maxlength: 80, default: '' },
    passwordHash: { type: String, required: true },
    otpHash: { type: String, required: true },
    otpExpiresAt: { type: Date, required: true },
    attempts: { type: Number, default: 0 },
    lastSentAt: { type: Date, required: true },
    sendCount: { type: Number, default: 1 },
    registeredIp: String,
    // Whole pending record removed 24h after creation
    expireAt: { type: Date, default: () => new Date(Date.now() + 24 * 60 * 60 * 1000), index: { expires: 0 } },
  },
  { timestamps: true }
);

export default mongoose.model('PendingRegistration', pendingRegistrationSchema);
