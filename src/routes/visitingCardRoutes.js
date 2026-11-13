import { Router } from 'express';
import { createUploader } from '../middleware/upload.js';
import { getCard, updateCard } from '../controllers/visitingCardController.js';

const router = Router();
const upload = createUploader('visiting-card').fields([
  { name: 'frontImage', maxCount: 1 },
  { name: 'backImage', maxCount: 1 },
]);

router.route('/').get(getCard).put(upload, updateCard);

export default router;
