import { Router } from 'express';
import { optionalUser } from '../middleware/userAuth.js';
import { visitorCookie } from '../middleware/visitorCookie.js';
import { chatIdentityLimiter, chatLimiter, chatOtpLimiter, chatSessionLimiter, formLimiter } from '../middleware/rateLimit.js';
import { createUploader, DOCX_TYPE } from '../middleware/upload.js';
import { getApplication, submitApplication } from '../controllers/chatApplicationController.js';

// Optional CV for a chatbot job application: kept in memory, type checked from content and
// stored privately by the controller
const resumeUpload = createUploader('chat-enquiries', {
  databaseFields: ['resume'],
  databaseTypes: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf', DOCX_TYPE],
}).single('resume');
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
  getVerification,
  requestVerification,
  confirmVerification,
  revokeVerification,
} from '../controllers/chatController.js';

// Public AI assistant API used by the website. Mounted at /api/public/chat.
const router = Router();

router.get('/status', getStatus);
// The visitor cookie is issued together with the first chat session
router.post('/session', chatSessionLimiter, visitorCookie, createSession);

// Identity for conversations (session token), the daily question quota (verified user or
// visitor cookie + session) and per-identity rate limits
router.use(requireVisitor, optionalUser, visitorCookie);
router.get('/usage', getUsage);
router.get('/conversations', listConversations);
router.route('/conversations/:id').get(getConversation).delete(deleteConversation);
router.post('/conversations/:id/regenerate', chatLimiter, chatIdentityLimiter, regenerate);
router.post('/messages', chatLimiter, chatIdentityLimiter, sendMessage);

// Job enquiries need a logged-in account or an email verified with a one-time code
router.get('/verification', getVerification);
router.post('/verification/request', chatOtpLimiter, requestVerification);
router.post('/verification/confirm', chatOtpLimiter, confirmVerification);
router.delete('/verification', revokeVerification);

// Job application from the chat (logged-in or email-verified only; consent required)
router.get('/conversations/:id/application', getApplication);
router.post('/conversations/:id/application', formLimiter, resumeUpload, submitApplication);

export default router;
