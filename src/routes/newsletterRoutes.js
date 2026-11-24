import { Router } from 'express';
import { authorize } from '../middleware/auth.js';
import {
  listSubscribers,
  exportSubscribers,
  updateSubscriber,
  deleteSubscriber,
  listCampaigns,
  sendTest,
  sendCampaign,
} from '../controllers/newsletterController.js';

// Admin newsletter management (mounted behind `protect`)
const router = Router();

router.get('/subscribers', listSubscribers);
router.get('/subscribers/export', exportSubscribers);
router.route('/subscribers/:id').patch(updateSubscriber).delete(deleteSubscriber);

router.get('/campaigns', listCampaigns);
router.post('/campaigns/test', sendTest);
// Emailing every subscriber is limited to superadmins
router.post('/campaigns', authorize('superadmin'), sendCampaign);

export default router;
