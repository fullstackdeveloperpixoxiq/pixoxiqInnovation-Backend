import { Router } from 'express';
import { createUploader } from '../middleware/upload.js';
import {
  getAbout,
  updateDraft,
  publish,
  reset,
  uploadImage,
  addItem,
  updateItem,
  removeItem,
  reorderItems,
} from '../controllers/aboutController.js';

// Admin About Us content (mounted behind `protect` in routes/index.js).
// Images are kept in the database (JPG/PNG/WEBP/AVIF, max 5 MB, real type checked from the content).
const upload = createUploader('about', { databaseFields: ['image'] }).single('image');

const router = Router();

router.route('/').get(getAbout).put(updateDraft);
router.post('/publish', publish);
router.post('/reset', reset);
router.post('/upload', upload, uploadImage);

// Repeatable items on the draft: :list is capabilities, pillars or journey
router.post('/:list', addItem);
router.patch('/:list/reorder', reorderItems);
router.route('/:list/:itemId').put(updateItem).delete(removeItem);

export default router;
