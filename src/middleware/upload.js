import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import multer from 'multer';
import ApiError from '../utils/ApiError.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const UPLOAD_ROOT = path.join(__dirname, '..', '..', 'uploads');

export const ALLOWED = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'application/pdf': '.pdf',
};

// Image types accepted for files that are kept in the database (see models/StoredFile.js)
const DATABASE_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

// Detects the real image type from the first bytes of a file, so a renamed file is rejected
export const sniffImageType = (buffer) => {
  if (!buffer || buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
};

// Detects the real type of any accepted upload (JPG, PNG, WEBP, SVG, PDF) from its content
export const sniffFileType = (buffer) => {
  const image = sniffImageType(buffer);
  if (image) return image;
  if (!buffer || buffer.length < 5) return null;
  if (buffer.toString('latin1', 0, 5) === '%PDF-') return 'application/pdf';
  const head = buffer.toString('utf8', 0, Math.min(buffer.length, 2048)).replace(/^﻿/, '');
  if (/^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head)) return 'image/svg+xml';
  return null;
};

// Creates a multer instance that stores files in uploads/<folder>.
// Fields listed in `databaseFields` are kept in memory (file.buffer) instead, for the
// controller to save in the database. `databaseTypes` lists the MIME types those fields accept.
export const createUploader = (folder, { databaseFields = [], databaseTypes = DATABASE_IMAGE_TYPES } = {}) => {
  const dest = path.join(UPLOAD_ROOT, folder);
  fs.mkdirSync(dest, { recursive: true });

  const disk = multer.diskStorage({
    destination: dest,
    filename: (req, file, cb) => {
      cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ALLOWED[file.mimetype]}`);
    },
  });
  const memory = multer.memoryStorage();
  const inDatabase = (file) => databaseFields.includes(file.fieldname);
  const storageFor = (file) => (inDatabase(file) ? memory : disk);

  return multer({
    storage: {
      _handleFile: (req, file, cb) => storageFor(file)._handleFile(req, file, cb),
      _removeFile: (req, file, cb) => storageFor(file)._removeFile(req, file, cb),
    },
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      if (inDatabase(file)) {
        if (databaseTypes.includes(file.mimetype)) return cb(null, true);
        return cb(ApiError.badRequest(databaseTypes === DATABASE_IMAGE_TYPES
          ? 'Only JPG, PNG or WEBP images are allowed'
          : 'Only JPG, PNG, WEBP, SVG or PDF files are allowed'));
      }
      if (ALLOWED[file.mimetype]) return cb(null, true);
      cb(ApiError.badRequest('Only JPG, PNG, WEBP, SVG or PDF files are allowed'));
    },
  });
};

// Deletes a previously uploaded file given its stored relative path (e.g. "certificates/abc.png")
export const removeUpload = (relativePath) => {
  if (!relativePath) return;
  const full = path.join(UPLOAD_ROOT, relativePath);
  if (!full.startsWith(UPLOAD_ROOT)) return;
  fs.promises.unlink(full).catch(() => {});
};

// Knowledge base documents: kept in memory only long enough to extract their text (the file
// itself is not stored). The real file type is verified from its content by ai/textExtract.js.
export const createDocumentUploader = ({ maxMb, extensions }) => {
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxMb * 1024 * 1024, files: 1 },
    fileFilter: (req, file, cb) => {
      if (extensions.includes(path.extname(file.originalname || '').toLowerCase())) return cb(null, true);
      cb(ApiError.badRequest(`Unsupported file type. Allowed: ${extensions.join(', ')}`));
    },
  }).single('file');

  // Turn multer's size error into a message with the real limit
  return (req, res, next) =>
    upload(req, res, (err) => {
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        return next(ApiError.badRequest(`File is too large (max ${maxMb} MB)`));
      }
      next(err);
    });
};
