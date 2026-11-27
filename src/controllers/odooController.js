import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import Message from '../models/Message.js';
import Application from '../models/Application.js';
import Vacancy from '../models/Vacancy.js';
import env from '../config/env.js';
import OdooConfig from '../models/OdooConfig.js';
import { decryptSecret, encryptSecret, isEncryptionConfigured } from '../ai/crypto.js';
import { logAi } from '../ai/logger.js';
import {
  isOdooEnabled,
  loadOdooConnection,
  normalizeOdooUrl,
  odooApiMode,
  odooBaseUrl,
  odooCall,
  odooConnectionSource,
  testOdooConnection,
} from '../services/odoo.js';
import { runOdooSync } from '../services/odooSync.js';

// Admin: connection check and counts of synced / waiting records
export const getOdooStatus = asyncHandler(async (req, res) => {
  const base = { configured: isOdooEnabled(), url: odooBaseUrl() || null, source: odooConnectionSource() };
  if (!base.configured) return res.json({ success: true, data: { ...base, connected: false } });

  let connected = false;
  let error = null;
  try {
    await odooCall('res.users', 'search_count', { domain: [] });
    connected = true;
  } catch (err) {
    error = err.message;
  }

  const [vacancies, messagesSynced, messagesPending, applicationsSynced, applicationsPending] = await Promise.all([
    Vacancy.countDocuments({ source: 'odoo', isActive: true }),
    Message.countDocuments({ odooId: { $ne: null } }),
    Message.countDocuments({ odooId: null }),
    Application.countDocuments({ odooId: { $ne: null } }),
    Application.countDocuments({ odooId: null }),
  ]);

  res.json({
    success: true,
    data: {
      ...base,
      connected,
      api: odooApiMode(),
      error,
      vacancies,
      messages: { synced: messagesSynced, pending: messagesPending },
      applications: { synced: applicationsSynced, pending: applicationsPending },
    },
  });
});

// Admin: run the sync now instead of waiting for the next interval
export const syncOdooNow = asyncHandler(async (req, res) => {
  if (!isOdooEnabled()) throw ApiError.badRequest('Odoo is not configured. Enter the connection in Odoo Integration settings.');
  const result = await runOdooSync();
  res.json({ success: true, message: 'Odoo sync finished', data: result });
});

// ---------- Odoo connection settings (superadmin) ----------

// Never returns the API key, only whether one is saved and its last 4 characters
const configView = (doc) => ({
  url: doc.url,
  db: doc.db,
  username: doc.username,
  apiKeySet: Boolean(doc.apiKeyLast4),
  apiKeyLast4: doc.apiKeyLast4,
  recruitmentEnabled: doc.recruitmentEnabled,
  defaultJobId: doc.defaultJobId,
  defaultJobName: doc.defaultJobName,
  sourceName: doc.sourceName,
  version: doc.version,
  apiMode: doc.apiMode,
  lastTest: doc.lastTest?.at ? doc.lastTest : null,
  // Which connection is in use: saved settings, or the ODOO_* environment variables
  activeSource: odooConnectionSource(),
  envConfigured: Boolean(env.odoo.url && env.odoo.db && env.odoo.apiKey),
  encryptionReady: isEncryptionConfigured(),
  updatedAt: doc.updatedAt,
});

const validUrl = (value) => {
  const url = normalizeOdooUrl(value);
  if (!url) return '';
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw ApiError.badRequest('Enter a valid Odoo URL, e.g. https://yourcompany.odoo.com');
  }
  const local = ['localhost', '127.0.0.1'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(local && !env.isProd)) throw ApiError.badRequest('The Odoo URL must use https://');
  return url;
};

export const getOdooConfig = asyncHandler(async (req, res) => {
  res.json({ success: true, data: configView(await OdooConfig.getSingleton()) });
});

export const updateOdooConfig = asyncHandler(async (req, res) => {
  const body = req.body || {};
  const doc = await OdooConfig.getSingleton({ withSecrets: true });
  if (body.url !== undefined) doc.url = validUrl(body.url);
  if (body.db !== undefined) doc.db = String(body.db).trim().slice(0, 120);
  if (body.username !== undefined) doc.username = String(body.username).trim().slice(0, 200);
  if (typeof body.apiKey === 'string' && body.apiKey.trim()) {
    const key = body.apiKey.trim();
    doc.apiKeyEnc = encryptSecret(key); // throws a clear error when AI_ENCRYPTION_KEY is missing
    doc.apiKeyLast4 = key.slice(-4);
  }
  if (body.clearApiKey === true) {
    doc.apiKeyEnc = '';
    doc.apiKeyLast4 = '';
  }
  if (body.recruitmentEnabled !== undefined) {
    if (typeof body.recruitmentEnabled !== 'boolean') throw ApiError.badRequest('recruitmentEnabled must be true or false');
    doc.recruitmentEnabled = body.recruitmentEnabled;
  }
  if (body.defaultJobId !== undefined) {
    const id = body.defaultJobId === null || body.defaultJobId === '' ? null : Number(body.defaultJobId);
    if (id !== null && (!Number.isInteger(id) || id <= 0)) throw ApiError.badRequest('Invalid default job position');
    doc.defaultJobId = id;
    doc.defaultJobName = id ? String(body.defaultJobName || '').slice(0, 200) : '';
  }
  if (body.sourceName !== undefined) doc.sourceName = String(body.sourceName).trim().slice(0, 100) || 'PIXOXIQ AI Assistant';
  doc.updatedBy = req.admin._id;
  await doc.save();
  await loadOdooConnection();
  await logAi({
    level: 'info',
    source: 'recruitment',
    message: `Odoo integration settings saved by ${req.admin.email} (recruitment sync ${doc.recruitmentEnabled ? 'enabled' : 'disabled'})`,
  });
  res.json({ success: true, message: 'Odoo settings saved', data: configView(doc) });
});

// Tests the values in the form (falls back to the saved key when none is typed)
export const testOdooConfig = asyncHandler(async (req, res) => {
  const body = req.body || {};
  const doc = await OdooConfig.getSingleton({ withSecrets: true });
  let conn;
  if (body.url || body.apiKey) {
    const savedKey = doc.apiKeyEnc ? decryptSecret(doc.apiKeyEnc) : env.odoo.apiKey;
    conn = {
      url: validUrl(body.url || doc.url || env.odoo.url),
      db: String(body.db || doc.db || env.odoo.db || '').trim(),
      username: String(body.username || doc.username || env.odoo.username || '').trim(),
      apiKey: String(body.apiKey || '').trim() || savedKey,
    };
  }
  const report = await testOdooConnection(conn);
  doc.lastTest = { ok: report.ok, at: new Date(), message: report.message };
  if (report.version) doc.version = report.version;
  if (report.apiMode) doc.apiMode = report.apiMode;
  await doc.save();
  res.json({ success: true, data: report });
});

// Job positions in Odoo, to choose the default for general career enquiries
export const listOdooJobs = asyncHandler(async (req, res) => {
  if (!isOdooEnabled()) throw ApiError.badRequest('Save a working Odoo connection first.');
  const jobs = await odooCall('hr.job', 'search_read', { domain: [], fields: ['name', 'active'], order: 'name asc', limit: 500 });
  res.json({ success: true, data: jobs.map((j) => ({ id: j.id, name: j.name })) });
});
