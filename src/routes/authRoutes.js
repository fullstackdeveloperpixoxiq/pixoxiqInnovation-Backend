import { Router } from 'express';
import {
  login,
  getMe,
  updateProfile,
  changePassword,
  listAdmins,
  createAdmin,
  updateAdmin,
  deleteAdmin,
} from '../controllers/authController.js';
import { protect, authorize } from '../middleware/auth.js';
import { loginLimiter } from '../middleware/rateLimit.js';

const router = Router();

router.post('/login', loginLimiter, login);

router.use(protect);
router.get('/me', getMe);
router.patch('/me', updateProfile);
router.patch('/me/password', changePassword);

router.route('/admins').get(authorize('superadmin'), listAdmins).post(authorize('superadmin'), createAdmin);
router.route('/admins/:id').patch(authorize('superadmin'), updateAdmin).delete(authorize('superadmin'), deleteAdmin);

export default router;
