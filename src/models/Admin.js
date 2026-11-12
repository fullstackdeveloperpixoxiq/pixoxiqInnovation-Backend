import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import env from '../config/env.js';
import { toJSONPlugin } from './plugins.js';

const adminSchema = new mongoose.Schema(
  {
    name: { type: String, required: [true, 'Name is required'], trim: true, maxlength: 80 },
    email: {
      type: String,
      required: [true, 'Email is required'],
      unique: true,
      lowercase: true,
      trim: true,
      match: [/^\S+@\S+\.\S+$/, 'Enter a valid email'],
    },
    password: {
      type: String,
      required: [true, 'Password is required'],
      minlength: [8, 'Password must be at least 8 characters'],
      select: false,
    },
    role: { type: String, enum: ['superadmin', 'admin'], default: 'admin' },
    isActive: { type: Boolean, default: true },
    lastLogin: Date,
    passwordChangedAt: Date,
  },
  { timestamps: true }
);

adminSchema.pre('save', async function hashPassword(next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 12);
  if (!this.isNew) this.passwordChangedAt = new Date();
  next();
});

adminSchema.methods.comparePassword = function comparePassword(candidate) {
  return bcrypt.compare(candidate, this.password);
};

adminSchema.methods.generateToken = function generateToken() {
  return jwt.sign({ id: this._id, role: this.role }, env.jwtSecret, { expiresIn: env.jwtExpiresIn });
};

adminSchema.plugin(toJSONPlugin);
adminSchema.set('toJSON', {
  virtuals: true,
  transform: (doc, ret) => {
    ret.id = ret._id?.toString();
    delete ret.__v;
    delete ret.password;
    return ret;
  },
});

export default mongoose.model('Admin', adminSchema);
