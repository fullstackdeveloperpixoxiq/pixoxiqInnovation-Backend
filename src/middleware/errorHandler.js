import multer from 'multer';
import env from '../config/env.js';
import ApiError from '../utils/ApiError.js';

export const notFound = (req, res, next) => {
  next(ApiError.notFound(`Route not found: ${req.method} ${req.originalUrl}`));
};

// eslint-disable-next-line no-unused-vars
export const errorHandler = (err, req, res, next) => {
  let statusCode = err.statusCode || 500;
  let message = err.message || 'Internal server error';
  let details = err.details;

  // Mongoose validation error -> 400 with per-field messages
  if (err.name === 'ValidationError') {
    statusCode = 400;
    details = Object.fromEntries(Object.entries(err.errors).map(([field, e]) => [field, e.message]));
    message = Object.values(details)[0] || 'Validation failed';
  }

  // Invalid ObjectId
  if (err.name === 'CastError') {
    statusCode = 400;
    message = `Invalid ${err.path}: ${err.value}`;
  }

  // Duplicate key
  if (err.code === 11000) {
    statusCode = 409;
    const field = Object.keys(err.keyValue || {})[0];
    message = field ? `${field} "${err.keyValue[field]}" already exists` : 'Duplicate value';
  }

  if (err instanceof multer.MulterError) {
    statusCode = 400;
    message = err.code === 'LIMIT_FILE_SIZE' ? 'File is too large (max 5 MB)' : err.message;
  }

  if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
    statusCode = 401;
    message = 'Session expired, please log in again';
  }

  if (statusCode >= 500) console.error(err);

  res.status(statusCode).json({
    success: false,
    message,
    ...(details && { details }),
    ...(!env.isProd && statusCode >= 500 && { stack: err.stack }),
  });
};
