import { Router } from 'express';
import { protect } from '../middleware/auth.js';
import { createUploader } from '../middleware/upload.js';
import vacancyController from '../controllers/vacancyController.js';
import certificateController from '../controllers/certificateController.js';
import serviceController from '../controllers/serviceController.js';
import { getStats } from '../controllers/dashboardController.js';
import resourceRouter from './resourceRouter.js';
import authRoutes from './authRoutes.js';
import publicRoutes from './publicRoutes.js';
import messageRoutes from './messageRoutes.js';
import applicationRoutes from './applicationRoutes.js';
import visitingCardRoutes from './visitingCardRoutes.js';
import chatRoutes from './chatRoutes.js';
import aiRoutes from './aiRoutes.js';

const router = Router();

// Public
router.use('/public/chat', chatRoutes);
router.use('/public', publicRoutes);
router.use('/auth', authRoutes);

// Admin (JWT protected)
router.get('/dashboard/stats', protect, getStats);
router.use('/vacancies', protect, resourceRouter(vacancyController));
router.use('/services', protect, resourceRouter(serviceController));
router.use(
  '/certificates',
  protect,
  resourceRouter(certificateController, { uploadMiddleware: createUploader('certificates').single('image') })
);
router.use('/messages', protect, messageRoutes);
router.use('/applications', protect, applicationRoutes);
router.use('/visiting-card', protect, visitingCardRoutes);
router.use('/ai', protect, aiRoutes);

export default router;
