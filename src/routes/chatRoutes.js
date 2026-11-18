import { Router } from 'express';
import { chatLimiter, chatSessionLimiter } from '../middleware/rateLimit.js';
import {
  requireVisitor,
  getStatus,
  getUsage,
  createSession,
  listConversations,
  getConversation,
  deleteConversation,
  sendMessage,
  regenerate,
} from '../controllers/chatController.js';

// Public AI assistant API used by the website. Mounted at /api/public/chat.
const router = Router();

router.get('/status', getStatus);
router.post('/session', chatSessionLimiter, createSession);

router.use(requireVisitor);
router.get('/usage', getUsage);
router.get('/conversations', listConversations);
router.route('/conversations/:id').get(getConversation).delete(deleteConversation);
router.post('/conversations/:id/regenerate', chatLimiter, regenerate);
router.post('/messages', chatLimiter, sendMessage);

export default router;
