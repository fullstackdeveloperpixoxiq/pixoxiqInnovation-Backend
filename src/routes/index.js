import { Router } from 'express';
import { protect, authorize } from '../middleware/auth.js';
import { createUploader, ALLOWED } from '../middleware/upload.js';
import vacancyController from '../controllers/vacancyController.js';
import certificateController from '../controllers/certificateController.js';
import certificateImageController from '../controllers/certificateImageController.js';
import employeeController from '../controllers/employeeController.js';
import serviceController from '../controllers/serviceController.js';
import { getStats } from '../controllers/dashboardController.js';
import resourceRouter from './resourceRouter.js';
import authRoutes from './authRoutes.js';
import publicRoutes from './publicRoutes.js';
import messageRoutes from './messageRoutes.js';
import applicationRoutes from './applicationRoutes.js';
import visitingCardRoutes from './visitingCardRoutes.js';

const router = Router();

// Public
router.use('/public', publicRoutes);
router.use('/auth', authRoutes);

// Admin (JWT protected)
router.get('/dashboard/stats', protect, getStats);
router.use('/vacancies', protect, resourceRouter(vacancyController));
router.use('/services', protect, resourceRouter(serviceController));
router.use(
  '/certificates',
  protect,
  resourceRouter(certificateController, {
    // Kept in the database (not on disk) so images survive restarts and redeploys
    uploadMiddleware: createUploader('certificates', {
      databaseFields: ['image'],
      databaseTypes: Object.keys(ALLOWED),
    }).single('image'),
  })
);
router.use(
  '/certificate-images',
  protect,
  resourceRouter(certificateImageController, {
    uploadMiddleware: createUploader('certificate-images', {
      databaseFields: ['image'],
      databaseTypes: Object.keys(ALLOWED),
    }).single('image'),
  })
);
router.use(
  '/employees',
  protect,
  // Like the company visiting card: everyone can view, only a superadmin can change
  (req, res, next) => (req.method === 'GET' ? next() : authorize('superadmin')(req, res, next)),
  resourceRouter(employeeController, {
    uploadMiddleware: createUploader('employees', { databaseFields: ['photo'] }).single('photo'),
  })
);
router.use('/messages', protect, messageRoutes);
router.use('/applications', protect, applicationRoutes);
router.use('/visiting-card', protect, visitingCardRoutes);

export default router;
