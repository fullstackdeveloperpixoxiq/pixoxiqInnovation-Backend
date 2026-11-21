import { Router } from 'express';
import { authorize } from '../middleware/auth.js';
import { createUploader, DOCX_TYPE } from '../middleware/upload.js';
import { getCard, updateCard } from '../controllers/visitingCardController.js';

// Mounted behind `protect` in routes/index.js
const router = Router();

// The profile photo and brochure files are kept in the database so they survive restarts and redeploys.
// Real types are checked from the content in the controller.
const upload = createUploader('visiting-card', {
  databaseFields: ['photo', 'documentFiles'],
  databaseTypes: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf', DOCX_TYPE],
}).fields([
  { name: 'photo', maxCount: 1 },
  { name: 'documentFiles', maxCount: 20 },
]);

router.route('/').get(getCard).put(authorize('superadmin'), upload, updateCard);

export default router;
