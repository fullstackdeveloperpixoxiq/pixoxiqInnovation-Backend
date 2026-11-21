import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import User from '../models/User.js';
import PendingRegistration from '../models/PendingRegistration.js';
import { isEmailConfigured, sendEmail, registrationOtpEmail, hashToken } from '../services/emailService.js';
import env from '../config/env.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import { paginate } from '../utils/queryBuilder.js';
import { pickFields } from './crudFactory.js';

const str = (v) => (typeof v === 'string' ? v : undefined);

// ---------- Public (website visitors) ----------

const OTP_TTL_MIN = 10;
const OTP_MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN_SEC = 60;
const MAX_SENDS = 5;

const normEmail = (v) => (typeof v === 'string' ? v.toLowerCase().trim() : '');
const newOtp = () => crypto.randomInt(0, 1000000).toString().padStart(6, '0');

const maskEmail = (e) => e.replace(/^(.{2}).*(@.*)$/, '$1***$2');

// Sends a fresh OTP. The record is only saved once the provider accepts the email, so a
// delivery failure never triggers the resend cooldown or uses up a send.
const sendOtp = async (pending) => {
  const otp = newOtp();
  pending.otpHash = hashToken(otp);
  pending.otpExpiresAt = new Date(Date.now() + OTP_TTL_MIN * 60 * 1000);
  pending.attempts = 0;
  try {
    await sendEmail({ to: pending.email, ...registrationOtpEmail({ name: pending.name, otp, minutes: OTP_TTL_MIN }) });
  } catch (err) {
    console.error(
      `[registration-otp] delivery failed to=${maskEmail(pending.email)} provider=${env.email.provider} ` +
        `status=${err.status ?? 'n/a'} code=${err.providerCode ?? 'n/a'} message="${err.providerMessage ?? err.message}"`
    );
    // Nothing is saved on failure: the previous OTP (if any) stays valid and the user can retry immediately
    throw new ApiError(502, 'Could not send the verification email. Please try again shortly.');
  }
  pending.lastSentAt = new Date();
  pending.sendCount = (pending.sendCount || 0) + 1;
  await pending.save();
};

const otpResponse = (email) => ({
  success: true,
  message: `A verification code was sent to ${email}`,
  data: { email, expiresInSeconds: OTP_TTL_MIN * 60, resendAfterSeconds: RESEND_COOLDOWN_SEC },
});

// Step 1: validate details, store a pending registration and email a 6-digit OTP
export const register = asyncHandler(async (req, res) => {
  const { name, phone, company, city, password } = req.body;
  if (![name, req.body.email, phone, password].every((v) => typeof v === 'string' && v.trim())) {
    throw ApiError.badRequest('Name, email, phone and password are required');
  }
  if (password.length < 8) throw ApiError.badRequest('Password must be at least 8 characters');
  const email = normEmail(req.body.email);
  if (!/^\S+@\S+\.\S+$/.test(email)) throw ApiError.badRequest('Enter a valid email');
  if (!/^\+?[0-9\s-]{7,20}$/.test(phone.trim())) throw ApiError.badRequest('Enter a valid phone number');
  if (!isEmailConfigured()) throw new ApiError(503, 'Registration is temporarily unavailable');

  if (await User.exists({ email })) throw ApiError.badRequest('An account with this email already exists. Please log in.');

  let pending = await PendingRegistration.findOne({ email });
  if (pending && Date.now() - pending.lastSentAt.getTime() < RESEND_COOLDOWN_SEC * 1000) {
    throw ApiError.badRequest(`Please wait ${RESEND_COOLDOWN_SEC} seconds before requesting another code`);
  }
  if (pending && pending.sendCount >= MAX_SENDS) {
    throw ApiError.badRequest('Too many codes requested for this email. Try again later.');
  }
  const details = {
    name: name.trim(),
    phone: phone.trim(),
    company: str(company)?.trim() || '',
    city: str(city)?.trim() || '',
    passwordHash: await bcrypt.hash(password, 12),
    registeredIp: req.ip,
  };
  if (pending) pending.set(details);
  else pending = new PendingRegistration({ email, ...details, lastSentAt: new Date(0), sendCount: 0 });
  await sendOtp(pending);
  res.status(202).json(otpResponse(email));
});

// Step 2: confirm the OTP, create the account and log the user in
export const verifyRegistration = asyncHandler(async (req, res) => {
  const email = normEmail(req.body.email);
  const otp = typeof req.body.otp === 'string' || typeof req.body.otp === 'number' ? String(req.body.otp).trim() : '';
  if (!email || !/^\d{6}$/.test(otp)) throw ApiError.badRequest('Email and the 6-digit code are required');

  const pending = await PendingRegistration.findOne({ email });
  if (!pending) throw ApiError.badRequest('No pending registration for this email. Please register again.');
  if (pending.otpExpiresAt < new Date()) throw ApiError.badRequest('This code has expired. Request a new one.');
  if (pending.attempts >= OTP_MAX_ATTEMPTS) throw ApiError.badRequest('Too many wrong attempts. Request a new code.');

  const ok = crypto.timingSafeEqual(Buffer.from(hashToken(otp)), Buffer.from(pending.otpHash));
  if (!ok) {
    pending.attempts += 1;
    await pending.save();
    const left = OTP_MAX_ATTEMPTS - pending.attempts;
    throw ApiError.badRequest(left > 0 ? `Incorrect code. ${left} attempt(s) left.` : 'Too many wrong attempts. Request a new code.');
  }

  if (await User.exists({ email })) {
    await pending.deleteOne();
    throw ApiError.badRequest('An account with this email already exists. Please log in.');
  }
  const user = new User({
    name: pending.name,
    email,
    phone: pending.phone,
    company: pending.company,
    city: pending.city,
    password: pending.passwordHash,
    lastLogin: new Date(),
    registeredIp: pending.registeredIp,
  });
  user.$locals.passwordHashed = true;
  await user.save();
  await pending.deleteOne();
  res.status(201).json({ success: true, message: 'Email verified. Account created', data: { token: user.generateToken(), user } });
});

export const resendRegistrationOtp = asyncHandler(async (req, res) => {
  const email = normEmail(req.body.email);
  if (!email) throw ApiError.badRequest('Email is required');
  const pending = await PendingRegistration.findOne({ email });
  if (!pending) throw ApiError.badRequest('No pending registration for this email. Please register again.');
  const waitMs = RESEND_COOLDOWN_SEC * 1000 - (Date.now() - pending.lastSentAt.getTime());
  if (waitMs > 0) throw ApiError.badRequest(`Please wait ${Math.ceil(waitMs / 1000)} seconds before requesting another code`);
  if (pending.sendCount >= MAX_SENDS) throw ApiError.badRequest('Too many codes requested for this email. Try again later.');
  await sendOtp(pending);
  res.json(otpResponse(email));
});

export const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
    throw ApiError.badRequest('Email and password are required');
  }
  const user = await User.findOne({ email: email.toLowerCase().trim() }).select('+password');
  if (!user || !(await user.comparePassword(password))) throw ApiError.unauthorized('Invalid email or password');
  if (!user.isActive) throw ApiError.forbidden('This account has been disabled');

  user.lastLogin = new Date();
  await user.save({ validateBeforeSave: false });
  res.json({ success: true, message: `Welcome back, ${user.name}`, data: { token: user.generateToken(), user } });
});

export const getMe = asyncHandler(async (req, res) => {
  res.json({ success: true, data: req.user });
});

// ---------- Admin ----------

export const listUsers = asyncHandler(async (req, res) => {
  const { items, pagination } = await paginate(User, req.query, {
    searchFields: ['name', 'email', 'phone', 'company', 'city'],
    filterFields: ['isActive'],
    defaultSort: '-createdAt',
  });
  const [active, disabled] = await Promise.all([
    User.countDocuments({ isActive: true }),
    User.countDocuments({ isActive: false }),
  ]);
  res.json({ success: true, data: items, pagination, counts: { true: active, false: disabled } });
});

export const getUser = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id).select('+registeredIp');
  if (!user) throw ApiError.notFound('User not found');
  res.json({ success: true, data: user });
});

export const updateUser = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) throw ApiError.notFound('User not found');
  user.set(pickFields(req.body, ['isActive', 'notes']));
  await user.save();
  res.json({ success: true, message: 'User updated', data: user });
});

export const deleteUser = asyncHandler(async (req, res) => {
  const user = await User.findByIdAndDelete(req.params.id);
  if (!user) throw ApiError.notFound('User not found');
  res.json({ success: true, message: 'User deleted', data: { id: user.id } });
});
