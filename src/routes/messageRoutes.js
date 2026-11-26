import { Router } from 'express';
import {
  listMessages,
  getMessage,
  updateMessage,
  deleteMessage,
  bulkMessages,
  getMessageAttachment,
} from '../controllers/messageController.js';

const router = Router();

router.get('/', listMessages);
router.post('/bulk', bulkMessages);
router.get('/:id/attachments/:index', getMessageAttachment);
router.route('/:id').get(getMessage).patch(updateMessage).delete(deleteMessage);

export default router;
