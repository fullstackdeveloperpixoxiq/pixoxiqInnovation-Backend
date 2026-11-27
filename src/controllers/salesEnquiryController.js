import mongoose from 'mongoose';
import SalesEnquiry, { ENQUIRY_STATUSES, MAX_PRODUCTS, MAX_IMAGES_PER_PRODUCT } from '../models/SalesEnquiry.js';
import StoredFile from '../models/StoredFile.js';
import { sniffImageType } from '../middleware/upload.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import { paginate } from '../utils/queryBuilder.js';
import { queueEnquiry } from '../services/odooSync.js';

// Sales users see and edit only the enquiries they created; admins see everyone's
const isSales = (req) => req.admin.role === 'sales';
const scope = (req) => (isSales(req) ? { createdBy: req.admin._id } : {});

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const CLIENT_FIELDS = ['clientName', 'phone', 'place', 'email', 'company', 'brandName', 'notes'];
const FLAGS = ['hasEcommerce', 'needsEcommerce', 'hasBrand', 'needsBranding'];
const removeFiles = (ids) => ids.length && StoredFile.deleteMany({ _id: { $in: ids } }).catch(() => {});

const findOwn = async (req) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw ApiError.notFound('Enquiry not found');
  const enquiry = await SalesEnquiry.findOne({ _id: req.params.id, ...scope(req) });
  if (!enquiry) throw ApiError.notFound('Enquiry not found');
  return enquiry;
};

// The form is sent as multipart: a JSON `data` field plus image files named `product_<index>`
// (index = position in data.products). Existing images are kept by listing their ids in product.images.
const readBody = (req) => {
  let data;
  try {
    data = typeof req.body.data === 'string' ? JSON.parse(req.body.data) : req.body;
  } catch {
    throw ApiError.badRequest('Invalid form data');
  }
  if (!data || typeof data !== 'object') throw ApiError.badRequest('Invalid form data');
  return data;
};

const buildFields = (data) => {
  const fields = {};
  CLIENT_FIELDS.forEach((k) => {
    if (data[k] !== undefined) fields[k] = typeof data[k] === 'string' ? data[k] : '';
  });
  FLAGS.forEach((k) => {
    if (data[k] !== undefined) fields[k] = data[k] === true;
  });
  if (data.status !== undefined) {
    if (!ENQUIRY_STATUSES.includes(data.status)) throw ApiError.badRequest('Invalid status');
    fields.status = data.status;
  }
  return fields;
};

// Saves the uploaded images and returns the products array ready for the model
const buildProducts = async (data, files, keepable) => {
  const list = Array.isArray(data.products) ? data.products : [];
  if (list.length > MAX_PRODUCTS) throw ApiError.badRequest(`Up to ${MAX_PRODUCTS} products per enquiry`);

  // Check every file before saving any of them
  const byIndex = {};
  for (const f of files) {
    const m = /^product_(\d+)$/.exec(f.fieldname);
    const index = m ? Number(m[1]) : -1;
    if (index < 0 || index >= list.length) throw ApiError.badRequest('Image does not belong to a product');
    const type = sniffImageType(f.buffer);
    if (!IMAGE_TYPES.includes(type)) throw ApiError.badRequest(`${f.originalname || 'Image'}: only JPG, PNG or WEBP images are allowed`);
    (byIndex[index] ||= []).push({ f, type });
  }

  const created = [];
  try {
    const products = [];
    for (let i = 0; i < list.length; i += 1) {
      const p = list[i] || {};
      const kept = (Array.isArray(p.images) ? p.images : []).filter((id) => keepable.has(String(id)));
      const uploads = byIndex[i] || [];
      if (kept.length + uploads.length > MAX_IMAGES_PER_PRODUCT) {
        throw ApiError.badRequest(`Up to ${MAX_IMAGES_PER_PRODUCT} images per product`);
      }
      const saved = await Promise.all(
        uploads.map(({ f, type }) =>
          StoredFile.create({ data: f.buffer, contentType: type, size: f.size, purpose: 'enquiry/product', filename: (f.originalname || 'image').slice(0, 200) })
        )
      );
      created.push(...saved.map((s) => s._id));
      products.push({
        ...(p.id && mongoose.isValidObjectId(p.id) && { _id: p.id }),
        name: typeof p.name === 'string' ? p.name : '',
        description: typeof p.description === 'string' ? p.description : '',
        price: Number(p.price) || 0,
        quantity: Number(p.quantity) || 0,
        images: [...kept, ...saved.map((s) => s._id)],
      });
    }
    return { products, created };
  } catch (err) {
    removeFiles(created);
    throw err;
  }
};

const populated = (query) => query.populate('createdBy', 'name email').populate('updatedBy', 'name email');

// ---------- Handlers ----------

export const listEnquiries = asyncHandler(async (req, res) => {
  const base = scope(req);
  // paginate only accepts string filter values, so the owner id is passed as a string
  const query = { ...req.query, ...(isSales(req) && { createdBy: String(req.admin._id) }) };
  const { items, pagination } = await paginate(SalesEnquiry, query, {
    searchFields: ['clientName', 'phone', 'place', 'email', 'company', 'brandName'],
    filterFields: ['status', 'createdBy'],
    defaultSort: '-createdAt',
    populate: { path: 'createdBy', select: 'name email' },
  });

  const grouped = await SalesEnquiry.aggregate([{ $match: base }, { $group: { _id: '$status', count: { $sum: 1 }, value: { $sum: '$grandTotal' } } }]);
  const counts = Object.fromEntries(ENQUIRY_STATUSES.map((s) => [s, 0]));
  let totalValue = 0;
  grouped.forEach((g) => {
    counts[g._id] = g.count;
    totalValue += g.value;
  });
  res.json({ success: true, data: items, pagination, counts, totalValue });
});

export const getEnquiry = asyncHandler(async (req, res) => {
  await findOwn(req);
  const enquiry = await populated(SalesEnquiry.findById(req.params.id));
  res.json({ success: true, data: enquiry });
});

export const createEnquiry = asyncHandler(async (req, res) => {
  const data = readBody(req);
  const { products, created } = await buildProducts(data, req.files || [], new Set());
  let enquiry;
  try {
    enquiry = await SalesEnquiry.create({ ...buildFields(data), products, createdBy: req.admin._id, updatedBy: req.admin._id });
  } catch (err) {
    removeFiles(created);
    throw err;
  }
  queueEnquiry(enquiry); // create the lead in Odoo CRM (background)
  res.status(201).json({ success: true, message: 'Enquiry saved', data: await populated(SalesEnquiry.findById(enquiry._id)) });
});

export const updateEnquiry = asyncHandler(async (req, res) => {
  const enquiry = await findOwn(req);
  const data = readBody(req);
  const before = enquiry.products.flatMap((p) => p.images.map(String));
  const { products, created } = await buildProducts(data, req.files || [], new Set(before));

  enquiry.set({ ...buildFields(data), products, updatedBy: req.admin._id, odooDirty: true, odooAttempts: 0 });
  try {
    await enquiry.save();
  } catch (err) {
    removeFiles(created);
    throw err;
  }
  const after = new Set(enquiry.products.flatMap((p) => p.images.map(String)));
  removeFiles(before.filter((id) => !after.has(id))); // images removed in the form

  queueEnquiry(enquiry); // update the lead in Odoo CRM (background)
  res.json({ success: true, message: 'Enquiry updated', data: await populated(SalesEnquiry.findById(enquiry._id)) });
});

export const deleteEnquiry = asyncHandler(async (req, res) => {
  const enquiry = await findOwn(req);
  await enquiry.deleteOne();
  removeFiles(enquiry.products.flatMap((p) => p.images));
  res.json({ success: true, message: 'Enquiry deleted', data: { id: enquiry.id } });
});

// Product image, for signed-in staff only (client product photos are not public)
export const getEnquiryImage = asyncHandler(async (req, res) => {
  const enquiry = await findOwn(req);
  const owns = enquiry.products.some((p) => p.images.some((id) => String(id) === req.params.fileId));
  const file = owns ? await StoredFile.findById(req.params.fileId) : null;
  if (!file) throw ApiError.notFound('Image not found');
  res.set({ 'Content-Type': file.contentType, 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' });
  res.send(file.data);
});
