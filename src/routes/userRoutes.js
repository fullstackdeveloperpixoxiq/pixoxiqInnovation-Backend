import { Router } from 'express';
import { register, verifyRegistration, resendRegistrationOtp, login, getMe, listUsers, getUser, updateUser, deleteUser } from '../controllers/userController.js';
import { protectUser } from '../middleware/userAuth.js';
import { myApplications } from '../controllers/applicationController.js';
import { loginLimiter, formLimiter, otpLimiter } from '../middleware/rateLimit.js';

// Public website accounts: /api/account/*
export const accountRoutes = Router();
accountRoutes.post('/register', formLimiter, register);
accountRoutes.post('/register/verify', otpLimiter, verifyRegistration);
accountRoutes.post('/register/resend', otpLimiter, resendRegistrationOtp);
accountRoutes.post('/login', loginLimiter, login);
accountRoutes.get('/me', protectUser, getMe);
accountRoutes.get('/applications', protectUser, myApplications);

// Admin management: /api/users/* (mounted behind `protect`)
export const adminUserRoutes = Router();
adminUserRoutes.get('/', listUsers);
adminUserRoutes.route('/:id').get(getUser).patch(updateUser).delete(deleteUser);
