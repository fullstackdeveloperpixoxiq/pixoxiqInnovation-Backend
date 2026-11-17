import { Router } from 'express';
import env from '../config/env.js';
import { authorize } from '../middleware/auth.js';
import { aiAdminLimiter } from '../middleware/rateLimit.js';
import { createDocumentUploader } from '../middleware/upload.js';
import { SUPPORTED_EXTENSIONS } from '../ai/textExtract.js';
import {
  getProviders,
  getConfig,
  listModels,
  testConfig,
  saveTarget,
  clearTarget,
  getSettings,
  updateSettings,
  testChat,
} from '../controllers/aiConfigController.js';
import * as knowledge from '../controllers/knowledgeController.js';
import {
  getOverview,
  getUsage,
  listLogs,
  clearLogs,
  listConversations,
  getConversation,
  deleteConversation,
} from '../controllers/aiAdminController.js';

// Admin API of the AI assistant. Mounted behind `protect` in routes/index.js.
// Provider credentials and assistant settings can only be changed by superadmins.
const router = Router();
const superadmin = authorize('superadmin');
const uploadDocument = createDocumentUploader({ maxMb: env.ai.maxDocumentMb, extensions: SUPPORTED_EXTENSIONS });

// Dashboard & analytics
router.get('/overview', getOverview);
router.get('/usage', getUsage);
router.get('/logs', listLogs);
router.delete('/logs', superadmin, clearLogs);

// Provider configuration
router.get('/providers', getProviders);
router.get('/config', getConfig);
router.post('/config/models', superadmin, aiAdminLimiter, listModels);
router.post('/config/test', superadmin, aiAdminLimiter, testConfig);
router.put('/config/:purpose', superadmin, aiAdminLimiter, saveTarget);
router.delete('/config/:purpose', superadmin, clearTarget);

// Assistant settings
router.get('/settings', getSettings);
router.put('/settings', superadmin, updateSettings);
router.post('/test-chat', aiAdminLimiter, testChat);

// Knowledge base
router.get('/knowledge', knowledge.listEntries);
router.get('/knowledge/categories', knowledge.listCategories);
router.post('/knowledge', knowledge.createEntry);
router.post('/knowledge/upload', uploadDocument, knowledge.uploadDocument);
router.post('/knowledge/reindex', knowledge.reindexAll);
router.post('/knowledge/sync-website', knowledge.syncWebsite);
router.post('/knowledge/search', aiAdminLimiter, knowledge.searchTest);
router.route('/knowledge/:id').get(knowledge.getEntry).put(knowledge.updateEntry).delete(knowledge.deleteEntry);
router.put('/knowledge/:id/file', uploadDocument, knowledge.replaceDocument);
router.post('/knowledge/:id/reindex', knowledge.reindexEntry);

// Conversations
router.get('/conversations', listConversations);
router.route('/conversations/:id').get(getConversation).delete(deleteConversation);

export default router;
