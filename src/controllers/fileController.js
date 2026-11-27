import mongoose from 'mongoose';
import StoredFile from '../models/StoredFile.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';

const PRIVATE_PURPOSES = ['application/resume', 'chat-enquiry/resume'];

// Public: serves a file kept in the database (e.g. the visiting card profile photo).
// Every upload gets a new id, so a given URL never changes content and can be cached forever.
export const getFile = asyncHandler(async (req, res) => {
  const file = mongoose.isValidObjectId(req.params.id) ? await StoredFile.findById(req.params.id) : null;
  // Candidate CVs are private: only admins can download them, through their own endpoints
  if (!file || PRIVATE_PURPOSES.includes(file.purpose)) throw ApiError.notFound('File not found');

  res.set({
    'Content-Type': file.contentType,
    'Cache-Control': 'public, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
  });
  // Stops scripts inside an uploaded SVG from running on the API origin
  if (file.contentType === 'image/svg+xml') {
    res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
  }
  // Uploaded documents (brochures) keep their original name when downloaded
  if (file.filename) {
    const name = file.filename.replace(/["\\\r\n]/g, '');
    const ascii = name.replace(/[^\x20-\x7e]/g, '_');
    res.set('Content-Disposition', `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`);
  }
  res.send(file.data);
});
