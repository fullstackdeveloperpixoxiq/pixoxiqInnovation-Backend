import Service from '../models/Service.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import crudFactory from './crudFactory.js';

const crud = crudFactory(Service, {
  name: 'Service',
  fields: ['title', 'slug', 'description', 'content', 'features', 'icon', 'isActive', 'order'],
  searchFields: ['title', 'slug', 'description'],
  filterFields: ['isActive'],
  defaultSort: 'order',
});

const getPublicBySlug = asyncHandler(async (req, res) => {
  const service = await Service.findOne({ slug: req.params.slug, isActive: true });
  if (!service) throw ApiError.notFound('Service not found');
  res.json({ success: true, data: service });
});

export default { ...crud, getPublicBySlug };
