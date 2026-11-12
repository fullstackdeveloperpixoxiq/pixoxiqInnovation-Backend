import Vacancy from '../models/Vacancy.js';
import Application from '../models/Application.js';
import asyncHandler from '../utils/asyncHandler.js';
import { paginate } from '../utils/queryBuilder.js';
import crudFactory from './crudFactory.js';

const crud = crudFactory(Vacancy, {
  name: 'Vacancy',
  fields: [
    'title',
    'department',
    'location',
    'type',
    'mode',
    'experience',
    'salary',
    'description',
    'requirements',
    'deadline',
    'isActive',
    'order',
  ],
  searchFields: ['title', 'department', 'location'],
  filterFields: ['isActive', 'department', 'type', 'mode'],
  defaultSort: 'order',
});

// Admin list enriched with the number of applications per vacancy
const list = asyncHandler(async (req, res) => {
  const { items, pagination } = await paginate(Vacancy, req.query, {
    searchFields: ['title', 'department', 'location'],
    filterFields: ['isActive', 'department', 'type', 'mode'],
    defaultSort: 'order',
  });

  const counts = await Application.aggregate([
    { $match: { vacancy: { $in: items.map((v) => v._id) } } },
    { $group: { _id: '$vacancy', count: { $sum: 1 } } },
  ]);
  const countMap = Object.fromEntries(counts.map((c) => [c._id.toString(), c.count]));

  res.json({
    success: true,
    data: items.map((v) => ({ ...v.toJSON(), applicationsCount: countMap[v.id] || 0 })),
    pagination,
  });
});

// Hide vacancies whose deadline has passed from the public site
const listPublic = asyncHandler(async (req, res) => {
  const now = new Date();
  const items = await Vacancy.find({
    isActive: true,
    $or: [{ deadline: null }, { deadline: { $exists: false } }, { deadline: { $gte: now } }],
  }).sort('order');
  res.json({ success: true, data: items });
});

export default { ...crud, list, listPublic };
