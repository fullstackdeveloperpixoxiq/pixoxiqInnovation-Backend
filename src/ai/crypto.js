import crypto from 'crypto';
import env from '../config/env.js';
import ApiError from '../utils/ApiError.js';

// AES-256-GCM encryption for provider API keys stored in the database.
// Stored format: v1:<iv b64>:<auth tag b64>:<ciphertext b64>

const loadKey = () => {
  const raw = env.ai.encryptionKey.trim();
  if (!raw) return null;
  const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  return key.length === 32 ? key : null;
};

const requireKey = () => {
  const key = loadKey();
  if (!key) {
    throw new ApiError(
      500,
      'AI_ENCRYPTION_KEY is missing or invalid on the server. Set a 32-byte key (64 hex characters) to store AI provider credentials.'
    );
  }
  return key;
};

export const isEncryptionConfigured = () => Boolean(loadKey());

export const encryptSecret = (plain) => {
  if (!plain) return '';
  const key = requireKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':');
};

export const decryptSecret = (stored) => {
  if (!stored) return '';
  const key = requireKey();
  const [version, iv, tag, data] = String(stored).split(':');
  if (version !== 'v1' || !iv || !tag || !data) throw new ApiError(500, 'Stored AI credential is corrupted. Re-enter the API key.');
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    throw new ApiError(500, 'Stored AI credential cannot be decrypted (was AI_ENCRYPTION_KEY changed?). Re-enter the API key.');
  }
};

export const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
