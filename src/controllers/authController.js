import Admin from '../models/Admin.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';

export const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
    throw ApiError.badRequest('Email and password are required');
  }

  const admin = await Admin.findOne({ email: email.toLowerCase().trim() }).select('+password');
  if (!admin || !(await admin.comparePassword(password))) {
    throw ApiError.unauthorized('Invalid email or password');
  }
  if (!admin.isActive) throw ApiError.forbidden('This account has been disabled');

  admin.lastLogin = new Date();
  await admin.save({ validateBeforeSave: false });

  res.json({ success: true, message: `Welcome back, ${admin.name}`, data: { token: admin.generateToken(), admin } });
});

export const getMe = asyncHandler(async (req, res) => {
  res.json({ success: true, data: req.admin });
});

export const updateProfile = asyncHandler(async (req, res) => {
  const { name, email } = req.body;
  if (typeof name === 'string') req.admin.name = name;
  if (typeof email === 'string') req.admin.email = email;
  await req.admin.save();
  res.json({ success: true, message: 'Profile updated', data: req.admin });
});

export const changePassword = asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) throw ApiError.badRequest('Current and new password are required');
  if (String(newPassword).length < 8) throw ApiError.badRequest('New password must be at least 8 characters');

  const admin = await Admin.findById(req.admin._id).select('+password');
  if (!(await admin.comparePassword(String(currentPassword)))) {
    throw ApiError.badRequest('Current password is incorrect');
  }

  admin.password = String(newPassword);
  await admin.save();

  // Old tokens are now invalid, issue a fresh one
  res.json({ success: true, message: 'Password changed', data: { token: admin.generateToken() } });
});

// ---------- Admin user management (superadmin only) ----------

export const listAdmins = asyncHandler(async (req, res) => {
  const admins = await Admin.find().sort('createdAt');
  res.json({ success: true, data: admins });
});

export const createAdmin = asyncHandler(async (req, res) => {
  const { name, email, password, role } = req.body;
  const admin = await Admin.create({ name, email, password, role: role === 'superadmin' ? 'superadmin' : 'admin' });
  res.status(201).json({ success: true, message: 'Admin created', data: admin });
});

export const updateAdmin = asyncHandler(async (req, res) => {
  const admin = await Admin.findById(req.params.id);
  if (!admin) throw ApiError.notFound('Admin not found');
  if (admin.id === req.admin.id && (req.body.isActive === false || req.body.role === 'admin')) {
    throw ApiError.badRequest('You cannot disable or demote your own account');
  }
  ['name', 'email'].forEach((key) => {
    if (typeof req.body[key] === 'string') admin[key] = req.body[key];
  });
  if (['admin', 'superadmin'].includes(req.body.role)) admin.role = req.body.role;
  if (typeof req.body.isActive === 'boolean') admin.isActive = req.body.isActive;
  if (req.body.password) admin.password = String(req.body.password);
  await admin.save();
  res.json({ success: true, message: 'Admin updated', data: admin });
});

export const deleteAdmin = asyncHandler(async (req, res) => {
  if (req.params.id === req.admin.id) throw ApiError.badRequest('You cannot delete your own account');
  const admin = await Admin.findByIdAndDelete(req.params.id);
  if (!admin) throw ApiError.notFound('Admin not found');
  res.json({ success: true, message: 'Admin deleted', data: { id: admin.id } });
});
