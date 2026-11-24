import mongoose from 'mongoose';
import Application, { APPLICATION_STATUSES } from '../models/Application.js';
import Vacancy from '../models/Vacancy.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import { buildListQuery } from '../utils/queryBuilder.js';
import { pickFields } from './crudFactory.js';
import { queueApplication } from '../services/odooSync.js';

// ---------- Public ----------

export const submitApplication = asyncHandler(async (req, res) => {
  if (req.body.website) return res.status(201).json({ success: true, message: 'Application received' });

  const data = pickFields(req.body, [
    'name',
    'email',
    'phone',
    'linkedin',
    'resumeUrl',
    'position',
    'experience',
    'message',
  ]);

  // Link to the vacancy when one was selected (by id, or by matching title)
  const { vacancyId } = req.body;
  let vacancy = null;
  if (vacancyId && mongoose.isValidObjectId(vacancyId)) vacancy = await Vacancy.findById(vacancyId);
  if (!vacancy && data.position) vacancy = await Vacancy.findOne({ title: data.position });

  const application = await Application.create({ ...data, vacancy: vacancy?._id || null });
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
  application.set(pickFields(req.body, ['status', 'notes']));
  await application.save();
  await application.populate('vacancy', 'title department');
  res.json({ success: true, message: 'Application updated', data: application });
});

export const deleteApplication = asyncHandler(async (req, res) => {
  const application = await Application.findByIdAndDelete(req.params.id);
  if (!application) throw ApiError.notFound('Application not found');
  res.json({ success: true, message: 'Application deleted', data: { id: application.id } });
});
