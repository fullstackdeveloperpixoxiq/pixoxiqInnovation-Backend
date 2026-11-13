import { Router } from 'express';
import { createUploader } from '../middleware/upload.js';
import { getCard, updateCard } from '../controllers/visitingCardController.js';

const router = Router();
// The founder profile photo is kept in the database so it survives restarts and redeploys
const upload = createUploader('visiting-card', { databaseFields: ['profilePhoto'] }).fields([
  { name: 'frontImage', maxCount: 1 },
  { name: 'backImage', maxCount: 1 },
  { name: 'profilePhoto', maxCount: 1 },
]);

router.route('/').get(getCard).put(upload, updateCard);

export default router;
