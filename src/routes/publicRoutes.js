import { Router } from 'express';
import vacancyController from '../controllers/vacancyController.js';
import certificateController from '../controllers/certificateController.js';
import certificateImageController from '../controllers/certificateImageController.js';
import serviceController from '../controllers/serviceController.js';
import { submitMessage } from '../controllers/messageController.js';
import { submitApplication } from '../controllers/applicationController.js';
import { getPublicCard } from '../controllers/visitingCardController.js';
import { getPublicEmployeeCard } from '../controllers/employeeController.js';
import { getFile } from '../controllers/fileController.js';
import { formLimiter } from '../middleware/rateLimit.js';

// Unauthenticated endpoints consumed by the public website
const router = Router();

router.get('/vacancies', vacancyController.listPublic);
router.get('/certificates', certificateController.listPublic);
router.get('/certificate-images', certificateImageController.listPublic);
router.get('/services', serviceController.listPublic);
router.get('/services/:slug', serviceController.getPublicBySlug);

router.get('/visiting-card', getPublicCard);
router.get('/visiting-card/:slug', getPublicEmployeeCard);
router.get('/files/:id', getFile);

router.post('/contact', formLimiter, submitMessage);
router.post('/applications', formLimiter, submitApplication);

export default router;
