import { Router } from 'express';
import {
  listApplications,
  getApplication,
  updateApplication,
  deleteApplication,
  getApplicationResume,
} from '../controllers/applicationController.js';

const router = Router();

router.get('/', listApplications);
router.get('/:id/resume', getApplicationResume);
router.route('/:id').get(getApplication).patch(updateApplication).delete(deleteApplication);

export default router;
