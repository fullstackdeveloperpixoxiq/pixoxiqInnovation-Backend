import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import env from '../config/env.js';
import Message from '../models/Message.js';
import Application from '../models/Application.js';
import Vacancy from '../models/Vacancy.js';
import { isOdooEnabled, odooApiMode, odooCall } from '../services/odoo.js';
import { runOdooSync } from '../services/odooSync.js';

// Admin: connection check and counts of synced / waiting records
export const getOdooStatus = asyncHandler(async (req, res) => {
  const base = { configured: isOdooEnabled(), url: env.odoo.url || null, db: env.odoo.db || null };
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
  if (!isOdooEnabled()) throw ApiError.badRequest('Odoo is not configured. Set ODOO_URL, ODOO_DB and ODOO_API_KEY.');
  const result = await runOdooSync();
  res.json({ success: true, message: 'Odoo sync finished', data: result });
});
