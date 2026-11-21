import { Router } from 'express';
import announcementController from '../controllers/announcementController.js';
import { createUploader } from '../middleware/upload.js';

// Admin announcements (mounted behind `protect`). The image is kept in the database.
const upload = createUploader('announcements', { databaseFields: ['image'] }).single('image');
const c = announcementController;

const router = Router();

router.route('/settings').get(c.getSettings).put(c.updateSettings);
router.route('/').get(c.list).post(upload, c.create);
router.patch('/reorder', c.reorder);
router.route('/:id').get(c.getOne).put(upload, c.update).delete(c.remove);
router.patch('/:id/status', c.setStatus);

export default router;
