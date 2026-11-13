import { Router } from 'express';
import vacancyController from '../controllers/vacancyController.js';
import certificateController from '../controllers/certificateController.js';
import serviceController from '../controllers/serviceController.js';
import { submitMessage } from '../controllers/messageController.js';
import { getPublicCard } from '../controllers/visitingCardController.js';
import { submitApplication } from '../controllers/applicationController.js';
import { formLimiter } from '../middleware/rateLimit.js';

// Unauthenticated endpoints consumed by the public website
const router = Router();

router.get('/vacancies', vacancyController.listPublic);
router.get('/certificates', certificateController.listPublic);
router.get('/services', serviceController.listPublic);
router.get('/services/:slug', serviceController.getPublicBySlug);
router.get('/visiting-card', getPublicCard);

router.post('/contact', formLimiter, submitMessage);
router.post('/applications', formLimiter, submitApplication);

export default router;
