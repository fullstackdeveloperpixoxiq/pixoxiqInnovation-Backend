import CertificateImage from '../models/CertificateImage.js';
import StoredFile from '../models/StoredFile.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import { sniffFileType } from '../middleware/upload.js';
import crudFactory, { pickFields } from './crudFactory.js';

const FIELDS = ['certificate', 'title', 'isActive', 'order'];
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'];

const crud = crudFactory(CertificateImage, {
  name: 'Certificate image',
  fields: FIELDS,
  searchFields: ['title'],
  filterFields: ['isActive', 'certificate'],
  defaultSort: 'order',
});

// Stores the uploaded image in the database (survives redeploys). Returns the StoredFile id.
const storeImage = async (file) => {
  if (!file) return undefined;
  const contentType = sniffFileType(file.buffer);
  if (!IMAGE_TYPES.includes(contentType)) throw ApiError.badRequest('Image must be a valid JPG, PNG, WEBP or SVG file');
  const stored = await StoredFile.create({
    data: file.buffer,
    contentType,
    size: file.size,
    purpose: 'certificate-gallery/image',
  });
  return stored.id;
};

const removeImage = (id) => {
  if (id && !id.includes('/')) StoredFile.deleteOne({ _id: id }).catch(() => {});
};

const create = asyncHandler(async (req, res) => {
  if (!req.file) throw ApiError.badRequest('Certificate image is required');
  const data = pickFields(req.body, FIELDS);
  data.image = await storeImage(req.file);
  try {
    const doc = await CertificateImage.create(data);
    res.status(201).json({ success: true, message: 'Certificate image added', data: doc });
  } catch (err) {
    removeImage(data.image);
    throw err;
  }
});

const update = asyncHandler(async (req, res) => {
  const doc = await CertificateImage.findById(req.params.id);
  if (!doc) throw ApiError.notFound('Certificate image not found');

  const image = await storeImage(req.file);
  const previousImage = doc.image;
  doc.set(pickFields(req.body, FIELDS));
  if (image) doc.image = image;

  try {
    await doc.save();
  } catch (err) {
    removeImage(image);
    throw err;
  }

  if (image && previousImage !== image) removeImage(previousImage);
  res.json({ success: true, message: 'Certificate image updated', data: doc });
});

const remove = asyncHandler(async (req, res) => {
  const doc = await CertificateImage.findByIdAndDelete(req.params.id);
  if (!doc) throw ApiError.notFound('Certificate image not found');
  removeImage(doc.image);
  res.json({ success: true, message: 'Certificate image deleted', data: { id: doc.id } });
});

// Deletes every image attached to a certification (used when the certification is deleted)
export const removeImagesFor = async (certificateId) => {
  const docs = await CertificateImage.find({ certificate: certificateId });
  docs.forEach((d) => removeImage(d.image));
  await CertificateImage.deleteMany({ certificate: certificateId });
};

export default { ...crud, create, update, remove };
