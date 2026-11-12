import { Router } from 'express';
import {
  listApplications,
  getApplication,
  updateApplication,
  deleteApplication,
} from '../controllers/applicationController.js';

const router = Router();

router.get('/', listApplications);
router.route('/:id').get(getApplication).patch(updateApplication).delete(deleteApplication);

export default router;
