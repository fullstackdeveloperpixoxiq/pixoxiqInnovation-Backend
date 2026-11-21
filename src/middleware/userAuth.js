import jwt from 'jsonwebtoken';
import env from '../config/env.js';
import User from '../models/User.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';

// Attaches the website visitor when a valid token is sent; guests continue without one
export const optionalUser = async (req, res, next) => {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return next();
  try {
    const decoded = jwt.verify(header.slice(7), env.jwtSecret);
    if (decoded.type === 'user') {
      const user = await User.findById(decoded.id);
      if (user?.isActive) req.user = user;
    }
  } catch {
    /* invalid or expired token: treat as guest */
  }
  next();
};

// Authenticates a website visitor (not an admin)
export const protectUser = asyncHandler(async (req, res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) throw ApiError.unauthorized('Please log in to continue');

  const decoded = jwt.verify(token, env.jwtSecret);
  if (decoded.type !== 'user') throw ApiError.unauthorized('Invalid session');
  const user = await User.findById(decoded.id);
  if (!user || !user.isActive) throw ApiError.unauthorized('Account not found or disabled');

  req.user = user;
  next();
});
