import { Router } from 'express';
import {
  listMessages,
  getMessage,
  updateMessage,
  deleteMessage,
  bulkMessages,
} from '../controllers/messageController.js';

const router = Router();

router.get('/', listMessages);
router.post('/bulk', bulkMessages);
router.route('/:id').get(getMessage).patch(updateMessage).delete(deleteMessage);

export default router;
