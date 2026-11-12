import Certificate from '../models/Certificate.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import { removeUpload } from '../middleware/upload.js';
import crudFactory, { pickFields } from './crudFactory.js';

const FIELDS = [
  'title',
  'subtitle',
  'description',
  'issuer',
  'credentialId',
  'credentialUrl',
  'icon',
  'issueDate',
  'expiryDate',
  'isActive',
  'order',
];

const crud = crudFactory(Certificate, {
  name: 'Certificate',
  fields: FIELDS,
  searchFields: ['title', 'subtitle', 'issuer', 'credentialId'],
  filterFields: ['isActive'],
  defaultSort: 'order',
});

// Empty strings from multipart forms should clear optional dates
const normalise = (data) => {
  ['issueDate', 'expiryDate'].forEach((key) => {
    if (data[key] === '') data[key] = null;
  });
  return data;
};

const uploadedPath = (file) => (file ? `certificates/${file.filename}` : undefined);

const create = asyncHandler(async (req, res) => {
  const data = normalise(pickFields(req.body, FIELDS));
  if (req.file) data.image = uploadedPath(req.file);
  try {
    const doc = await Certificate.create(data);
    res.status(201).json({ success: true, message: 'Certificate created', data: doc });
  } catch (err) {
    if (req.file) removeUpload(data.image);
    throw err;
  }
});

const update = asyncHandler(async (req, res) => {
  const doc = await Certificate.findById(req.params.id);
  if (!doc) {
    if (req.file) removeUpload(uploadedPath(req.file));
    throw ApiError.notFound('Certificate not found');
  }

  const previousImage = doc.image;
  doc.set(normalise(pickFields(req.body, FIELDS)));

  if (req.file) doc.image = uploadedPath(req.file);
  else if (req.body.removeImage === 'true') doc.image = '';

  try {
    await doc.save();
  } catch (err) {
    if (req.file) removeUpload(doc.image);
    throw err;
  }

  if (previousImage && previousImage !== doc.image) removeUpload(previousImage);
  res.json({ success: true, message: 'Certificate updated', data: doc });
});

const remove = asyncHandler(async (req, res) => {
  const doc = await Certificate.findByIdAndDelete(req.params.id);
  if (!doc) throw ApiError.notFound('Certificate not found');
  removeUpload(doc.image);
  res.json({ success: true, message: 'Certificate deleted', data: { id: doc.id } });
});

export default { ...crud, create, update, remove };
