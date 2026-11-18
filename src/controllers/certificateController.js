import Certificate from '../models/Certificate.js';
import StoredFile from '../models/StoredFile.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import { removeUpload, sniffFileType } from '../middleware/upload.js';
import crudFactory, { pickFields } from './crudFactory.js';
import { removeImagesFor } from './certificateImageController.js';

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

// The image arrives in memory (see routes/index.js) and is stored in the database, so it
// survives restarts and redeploys on hosts with an ephemeral disk. Returns the StoredFile id.
const storeImage = async (file) => {
  if (!file) return undefined;
  const contentType = sniffFileType(file.buffer);
  if (!contentType) throw ApiError.badRequest('Image must be a valid JPG, PNG, WEBP, SVG or PDF file');
  const stored = await StoredFile.create({
    data: file.buffer,
    contentType,
    size: file.size,
    purpose: 'certificate/image',
  });
  return stored.id;
};

// Deletes an image that is no longer used: a StoredFile id, or a legacy path in /uploads
const removeImage = (value) => {
  if (!value || /^https?:\/\//i.test(value)) return;
  if (value.includes('/')) return removeUpload(value);
  StoredFile.deleteOne({ _id: value }).catch(() => {});
};

const create = asyncHandler(async (req, res) => {
  const data = normalise(pickFields(req.body, FIELDS));
  const image = await storeImage(req.file);
  if (image) data.image = image;
  try {
    const doc = await Certificate.create(data);
    res.status(201).json({ success: true, message: 'Certificate created', data: doc });
  } catch (err) {
    removeImage(image);
    throw err;
  }
});

const update = asyncHandler(async (req, res) => {
  const doc = await Certificate.findById(req.params.id);
  if (!doc) throw ApiError.notFound('Certificate not found');

  const image = await storeImage(req.file);
  const previousImage = doc.image;
  doc.set(normalise(pickFields(req.body, FIELDS)));

  if (image) doc.image = image;
  else if (req.body.removeImage === 'true') doc.image = '';

  try {
    await doc.save();
  } catch (err) {
    removeImage(image);
    throw err;
  }

  if (previousImage && previousImage !== doc.image) removeImage(previousImage);
  res.json({ success: true, message: 'Certificate updated', data: doc });
});

const remove = asyncHandler(async (req, res) => {
  const doc = await Certificate.findByIdAndDelete(req.params.id);
  if (!doc) throw ApiError.notFound('Certificate not found');
  removeImage(doc.image);
  removeImagesFor(doc._id).catch(() => {});
  res.json({ success: true, message: 'Certificate deleted', data: { id: doc.id } });
});

export default { ...crud, create, update, remove };
