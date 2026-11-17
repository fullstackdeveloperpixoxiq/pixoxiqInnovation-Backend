import { Router } from 'express';
import { authorize } from '../middleware/auth.js';
import { createUploader } from '../middleware/upload.js';
import { getCard, updateCard } from '../controllers/visitingCardController.js';

// Mounted behind `protect` in routes/index.js
const router = Router();

// The profile photo is kept in the database so it survives restarts and redeploys
const upload = createUploader('visiting-card', { databaseFields: ['photo'] }).single('photo');

router.route('/').get(getCard).put(authorize('superadmin'), upload, updateCard);

export default router;
