import { Router } from 'express';
import vacancyController from '../controllers/vacancyController.js';
import certificateController from '../controllers/certificateController.js';
import certificateImageController from '../controllers/certificateImageController.js';
import serviceController from '../controllers/serviceController.js';
import { submitMessage, MAX_ATTACHMENTS } from '../controllers/messageController.js';
import { submitApplication } from '../controllers/applicationController.js';
import { getPublicCard } from '../controllers/visitingCardController.js';
import { getPublicEmployeeCard } from '../controllers/employeeController.js';
import { getFile } from '../controllers/fileController.js';
import { getPublicAbout } from '../controllers/aboutController.js';
import { formLimiter, newsletterLimiter, cookieConsentLimiter } from '../middleware/rateLimit.js';
import { saveConsent, getConsent, withdrawConsent } from '../controllers/cookieConsentController.js';
import announcementController from '../controllers/announcementController.js';
import { subscribe, verify, unsubscribe } from '../controllers/newsletterController.js';
import { optionalUser } from '../middleware/userAuth.js';
import { createUploader, DOCX_TYPE } from '../middleware/upload.js';

// Resume upload, kept in memory and saved to the database by the controller (type checked from content)
const resumeUpload = createUploader('applications', {
  databaseFields: ['resume'],
  databaseTypes: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf', DOCX_TYPE],
}).single('resume');

// Contact form attachments (ideas, product photos, specs): up to 3 PDF/image files, 5 MB each
const contactUpload = createUploader('messages', {
  databaseFields: ['attachments'],
  databaseTypes: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'],
}).array('attachments', MAX_ATTACHMENTS);

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
router.get('/about', getPublicAbout);

router.get('/announcements', announcementController.getPublic);
router.post('/newsletter/subscribe', newsletterLimiter, subscribe);
router.post('/newsletter/verify', newsletterLimiter, verify);
router.post('/newsletter/unsubscribe', newsletterLimiter, unsubscribe);

router.post('/cookie-consent', cookieConsentLimiter, optionalUser, saveConsent);
router.get('/cookie-consent/:visitorId', getConsent);
router.delete('/cookie-consent/:visitorId', cookieConsentLimiter, withdrawConsent);

router.post('/contact', formLimiter, contactUpload, submitMessage);
router.post('/applications', formLimiter, optionalUser, resumeUpload, submitApplication);

export default router;
