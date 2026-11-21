import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import env from '../config/env.js';

// Website visitor account (separate from Admin). Created through the public register form.
const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: [true, 'Name is required'], trim: true, maxlength: 100 },
    email: {
      type: String,
      required: [true, 'Email is required'],
      unique: true,
      lowercase: true,
      trim: true,
      match: [/^\S+@\S+\.\S+$/, 'Enter a valid email'],
    },
    phone: {
      type: String,
      required: [true, 'Phone number is required'],
      trim: true,
      match: [/^\+?[0-9\s-]{7,20}$/, 'Enter a valid phone number'],
    },
    company: { type: String, trim: true, maxlength: 120, default: '' },
    city: { type: String, trim: true, maxlength: 80, default: '' },
    password: {
      type: String,
      required: [true, 'Password is required'],
      minlength: [8, 'Password must be at least 8 characters'],
      select: false,
    },
    isActive: { type: Boolean, default: true },
    notes: { type: String, trim: true, maxlength: 2000, default: '' },
    lastLogin: Date,
    registeredIp: { type: String, select: false },
  },
  { timestamps: true }
);

userSchema.index({ createdAt: -1 });

userSchema.pre('save', async function hashPassword(next) {
  // $locals.passwordHashed: password is already a bcrypt hash (created from a verified PendingRegistration)
  if (!this.isModified('password') || this.$locals.passwordHashed) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

userSchema.methods.comparePassword = function comparePassword(candidate) {
  return bcrypt.compare(candidate, this.password);
};

// `type: 'user'` keeps visitor tokens from being accepted where admin tokens are expected and vice versa
userSchema.methods.generateToken = function generateToken() {
  return jwt.sign({ id: this._id, type: 'user' }, env.jwtSecret, { expiresIn: env.jwtExpiresIn });
};

userSchema.set('toJSON', {
  virtuals: true,
  transform: (doc, ret) => {
    ret.id = ret._id?.toString();
    delete ret.__v;
    delete ret.password;
    return ret;
  },
});

export default mongoose.model('User', userSchema);
