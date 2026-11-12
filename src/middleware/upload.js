import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import multer from 'multer';
import ApiError from '../utils/ApiError.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const UPLOAD_ROOT = path.join(__dirname, '..', '..', 'uploads');

const ALLOWED = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'application/pdf': '.pdf',
};

// Creates a multer instance that stores files in uploads/<folder>
export const createUploader = (folder) => {
  const dest = path.join(UPLOAD_ROOT, folder);
  fs.mkdirSync(dest, { recursive: true });

  return multer({
    storage: multer.diskStorage({
      destination: dest,
      filename: (req, file, cb) => {
        cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ALLOWED[file.mimetype]}`);
      },
    }),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
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
