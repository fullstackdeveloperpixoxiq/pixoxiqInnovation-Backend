import jwt from 'jsonwebtoken';
import env from '../config/env.js';
import Admin from '../models/Admin.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';

export const protect = asyncHandler(async (req, res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) throw ApiError.unauthorized('Please log in to continue');

  const decoded = jwt.verify(token, env.jwtSecret);
  const admin = await Admin.findById(decoded.id);
  if (!admin || !admin.isActive) throw ApiError.unauthorized('Account not found or disabled');

  // Invalidate tokens issued before the last password change
  if (admin.passwordChangedAt && decoded.iat * 1000 < admin.passwordChangedAt.getTime() - 1000) {
    throw ApiError.unauthorized('Password changed, please log in again');
  }

  req.admin = admin;
  next();
});

export const authorize = (...roles) => (req, res, next) => {
  if (!roles.includes(req.admin.role)) return next(ApiError.forbidden('You do not have permission for this action'));
  next();
};
