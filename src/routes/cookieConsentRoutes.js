import { Router } from 'express';
import { listConsents, exportConsents, deleteConsent } from '../controllers/cookieConsentController.js';

// Admin cookie consent records (mounted behind `protect`)
const router = Router();

router.get('/', listConsents);
router.get('/export', exportConsents);
router.delete('/:id', deleteConsent);

export default router;
