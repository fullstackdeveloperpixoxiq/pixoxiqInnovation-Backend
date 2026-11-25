import mongoose from 'mongoose';
import Application, { APPLICATION_STATUSES, publicStatus } from '../models/Application.js';
import Vacancy from '../models/Vacancy.js';
import StoredFile from '../models/StoredFile.js';
import { sniffDocumentType } from '../middleware/upload.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import { buildListQuery } from '../utils/queryBuilder.js';
import { pickFields } from './crudFactory.js';
import { queueApplication } from '../services/odooSync.js';
import { pushStatus } from '../services/odooStatus.js';

// ---------- Public ----------

export const submitApplication = asyncHandler(async (req, res) => {
  if (req.body.website) return res.status(201).json({ success: true, message: 'Application received' });

  const data = pickFields(req.body, [
    'name',
    'email',
    'phone',
    'linkedin',
    'position',
    'experience',
    'message',
  ]);

  // The resume is optional
  const file = req.file;
  const type = file && sniffDocumentType(file.buffer, file.originalname);
  if (file && !type) throw ApiError.badRequest('Resume must be a valid PDF, DOCX, JPG, PNG or WEBP file');

  // Link to the vacancy when one was selected (by id, or by matching title)
  const { vacancyId } = req.body;
  let vacancy = null;
  if (vacancyId && mongoose.isValidObjectId(vacancyId)) vacancy = await Vacancy.findById(vacancyId);
  if (!vacancy && data.position) vacancy = await Vacancy.findOne({ title: data.position });

  const resumeName = file ? (file.originalname || 'resume').slice(0, 200) : '';
  const stored = file
    ? await StoredFile.create({
        data: file.buffer,
        contentType: type,
        size: file.size,
        purpose: 'application/resume',
        filename: resumeName,
      })
    : null;

  let application;
  try {
    application = await Application.create({
      ...data,
      resumeFile: stored?._id || null,
      resumeName,
      vacancy: vacancy?._id || null,
      user: req.user?._id || null,
    });
  } catch (err) {
    if (stored) StoredFile.deleteOne({ _id: stored._id }).catch(() => {});
    throw err;
  }
  queueApplication(application); // also create an applicant in Odoo Recruitment (in the background)
  res.status(201).json({ success: true, message: 'Application received', data: { id: application.id } });
});

// ---------- Admin ----------

export const listApplications = asyncHandler(async (req, res) => {
  const { filter, page, limit, skip, sort } = buildListQuery(req.query, {
    searchFields: ['name', 'email', 'phone', 'position'],
    filterFields: ['status', 'vacancy'],
    defaultSort: '-createdAt',
  });

  const [items, total, grouped] = await Promise.all([
    Application.find(filter).sort(sort).skip(skip).limit(limit).populate('vacancy', 'title department'),
    Application.countDocuments(filter),
    Application.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
  ]);

  const counts = Object.fromEntries(APPLICATION_STATUSES.map((s) => [s, 0]));
  grouped.forEach((g) => {
    counts[g._id] = g.count;
  });

  res.json({
    success: true,
    data: items,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 },
    counts,
  });
});

export const getApplication = asyncHandler(async (req, res) => {
  const application = await Application.findById(req.params.id).populate('vacancy', 'title department');
  if (!application) throw ApiError.notFound('Application not found');
  res.json({ success: true, data: application });
});

export const updateApplication = asyncHandler(async (req, res) => {
  const application = await Application.findById(req.params.id);
  if (!application) throw ApiError.notFound('Application not found');
  const previousStatus = application.status;
  application.set(pickFields(req.body, ['status', 'notes']));
  await application.save();
  if (application.status !== previousStatus) pushStatus(application); // move the applicant in Odoo too (background)
  await application.populate('vacancy', 'title department');
  res.json({ success: true, message: 'Application updated', data: application });
});

export const deleteApplication = asyncHandler(async (req, res) => {
  const application = await Application.findByIdAndDelete(req.params.id);
  if (!application) throw ApiError.notFound('Application not found');
  if (application.resumeFile) StoredFile.deleteOne({ _id: application.resumeFile }).catch(() => {});
  res.json({ success: true, message: 'Application deleted', data: { id: application.id } });
});

// Admin only: streams the uploaded resume (resumes hold personal data, so they are not public)
export const getApplicationResume = asyncHandler(async (req, res) => {
  const application = await Application.findById(req.params.id).select('resumeFile');
  const file = application?.resumeFile ? await StoredFile.findById(application.resumeFile) : null;
  if (!file) throw ApiError.notFound('Resume not found');

  const name = (file.filename || 'resume').replace(/["\\\r\n]/g, '');
  const ascii = name.replace(/[^\x20-\x7e]/g, '_');
  res.set({
    'Content-Type': file.contentType,
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
  });
  res.send(file.data);
});

// Website: the logged-in visitor's own applications, with a simplified status
export const myApplications = asyncHandler(async (req, res) => {
  const apps = await Application.find({ user: req.user._id })
    .sort({ createdAt: -1 })
    .limit(50)
    .select('position status createdAt updatedAt');
  res.json({
    success: true,
    data: apps.map((a) => ({
      id: a.id,
      position: a.position,
      status: publicStatus(a.status),
      appliedAt: a.createdAt,
      updatedAt: a.updatedAt,
    })),
  });
});
