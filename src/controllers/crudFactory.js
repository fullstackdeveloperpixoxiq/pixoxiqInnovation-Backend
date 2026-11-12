import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import { paginate } from '../utils/queryBuilder.js';

// Copies only whitelisted fields from the request body (prevents mass assignment).
// Also normalises values sent as strings by multipart forms.
export const pickFields = (body = {}, fields = []) => {
  const data = {};
  fields.forEach((field) => {
    if (body[field] === undefined) return;
    let value = body[field];
    if (value === 'true') value = true;
    else if (value === 'false') value = false;
    else if (value === 'null') value = null;
    data[field] = value;
  });
  return data;
};

/**
 * Generates standard admin CRUD handlers for a model.
 * @param {mongoose.Model} Model
 * @param {object} options
 * @param {string} options.name          Human readable name used in messages
 * @param {string[]} options.fields      Fields admins are allowed to write
 * @param {string[]} options.searchFields Fields matched by ?search=
 * @param {string[]} options.filterFields Fields usable as exact filters (?isActive=true)
 * @param {string} options.defaultSort
 */
const crudFactory = (Model, { name, fields, searchFields = [], filterFields = [], defaultSort = 'order' }) => {
  const list = asyncHandler(async (req, res) => {
    const { items, pagination } = await paginate(Model, req.query, { searchFields, filterFields, defaultSort });
    res.json({ success: true, data: items, pagination });
  });

  const getOne = asyncHandler(async (req, res) => {
    const doc = await Model.findById(req.params.id);
    if (!doc) throw ApiError.notFound(`${name} not found`);
    res.json({ success: true, data: doc });
  });

  const create = asyncHandler(async (req, res) => {
    const doc = await Model.create(pickFields(req.body, fields));
    res.status(201).json({ success: true, message: `${name} created`, data: doc });
  });

  const update = asyncHandler(async (req, res) => {
    const doc = await Model.findById(req.params.id);
    if (!doc) throw ApiError.notFound(`${name} not found`);
    doc.set(pickFields(req.body, fields));
    await doc.save();
    res.json({ success: true, message: `${name} updated`, data: doc });
  });

  const remove = asyncHandler(async (req, res) => {
    const doc = await Model.findByIdAndDelete(req.params.id);
    if (!doc) throw ApiError.notFound(`${name} not found`);
    res.json({ success: true, message: `${name} deleted`, data: { id: doc.id } });
  });

  const toggleActive = asyncHandler(async (req, res) => {
    const doc = await Model.findById(req.params.id);
    if (!doc) throw ApiError.notFound(`${name} not found`);
    doc.isActive = !doc.isActive;
    await doc.save();
    res.json({
      success: true,
      message: `${name} ${doc.isActive ? 'published' : 'hidden'}`,
      data: doc,
    });
  });

  // Body: { ids: [id1, id2, ...] } in the desired display order
  const reorder = asyncHandler(async (req, res) => {
    const { ids } = req.body;
    if (!Array.isArray(ids) || !ids.length) throw ApiError.badRequest('ids array is required');
    await Model.bulkWrite(
      ids.map((id, index) => ({ updateOne: { filter: { _id: id }, update: { $set: { order: index } } } }))
    );
    res.json({ success: true, message: 'Order updated' });
  });

  // Public, active-only listing used by the website
  const listPublic = asyncHandler(async (req, res) => {
    const items = await Model.find({ isActive: true }).sort(defaultSort);
    res.json({ success: true, data: items });
  });

  return { list, getOne, create, update, remove, toggleActive, reorder, listPublic };
};

export default crudFactory;
