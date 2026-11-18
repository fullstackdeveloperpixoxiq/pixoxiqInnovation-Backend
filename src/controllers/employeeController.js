import Employee from '../models/Employee.js';
import VisitingCard, { PERSONAL_SOCIALS } from '../models/VisitingCard.js';
import StoredFile from '../models/StoredFile.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import { sniffFileType } from '../middleware/upload.js';
import crudFactory, { pickFields } from './crudFactory.js';

const FIELDS = ['name', 'designation', 'department', 'email', 'slug', 'qrUrl', 'isActive', 'order'];
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

const crud = crudFactory(Employee, {
  name: 'Employee',
  fields: FIELDS,
  searchFields: ['name', 'designation', 'department', 'slug'],
  filterFields: ['isActive'],
  defaultSort: 'order',
});

// Social links arrive as a JSON string from the multipart form
const parseSocials = (raw) => {
  if (raw === undefined) return undefined;
  let parsed = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw ApiError.badRequest('Social links must be a JSON object');
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw ApiError.badRequest('Social links must be a JSON object');
  return Object.fromEntries(PERSONAL_SOCIALS.map((key) => [key, typeof parsed[key] === 'string' ? parsed[key] : '']));
};

const storePhoto = async (file) => {
  if (!file) return undefined;
  const contentType = sniffFileType(file.buffer);
  if (!IMAGE_TYPES.includes(contentType)) throw ApiError.badRequest('Photo must be a valid JPG, PNG or WEBP image');
  const stored = await StoredFile.create({ data: file.buffer, contentType, size: file.size, purpose: 'employee/photo' });
  return stored.id;
};

const removePhoto = (id) => {
  if (id && !id.includes('/')) StoredFile.deleteOne({ _id: id }).catch(() => {});
};

const create = asyncHandler(async (req, res) => {
  const data = pickFields(req.body, FIELDS);
  const socials = parseSocials(req.body.personalSocials);
  if (socials) data.personalSocials = socials;
  data.photo = (await storePhoto(req.file)) || '';
  try {
    const doc = await Employee.create(data);
    res.status(201).json({ success: true, message: 'Employee added', data: doc });
  } catch (err) {
    removePhoto(data.photo);
    throw err;
  }
});

const update = asyncHandler(async (req, res) => {
  const doc = await Employee.findById(req.params.id);
  if (!doc) throw ApiError.notFound('Employee not found');

  const photo = await storePhoto(req.file);
  const previousPhoto = doc.photo;
  doc.set(pickFields(req.body, FIELDS));
  const socials = parseSocials(req.body.personalSocials);
  if (socials) doc.personalSocials = socials;
  if (photo) doc.photo = photo;
  else if (req.body.removePhoto === 'true') doc.photo = '';

  try {
    await doc.save();
  } catch (err) {
    removePhoto(photo);
    throw err;
  }
  if (previousPhoto && previousPhoto !== doc.photo) removePhoto(previousPhoto);
  res.json({ success: true, message: 'Employee updated', data: doc });
});

const remove = asyncHandler(async (req, res) => {
  const doc = await Employee.findByIdAndDelete(req.params.id);
  if (!doc) throw ApiError.notFound('Employee not found');
  removePhoto(doc.photo);
  res.json({ success: true, message: 'Employee deleted', data: { id: doc.id } });
});

// Public: the company card with this employee's own details on top.
// Phone, WhatsApp, location, company and About stay the company's. No brochure.
export const getPublicEmployeeCard = asyncHandler(async (req, res) => {
  const slug = String(req.params.slug || '').toLowerCase();
  const employee = await Employee.findOne({ slug, isActive: true });
  if (!employee) throw ApiError.notFound('Visiting card not found');

  const company = await VisitingCard.getSingleton();
  const { updatedBy, createdAt, photo, personalSocials, documents, qrUrl, ...base } = company.toJSON();

  res.json({
    success: true,
    data: {
      ...base,
      name: employee.name,
      designation: employee.designation,
      department: employee.department,
      email: employee.email || base.email,
      photoUrl: employee.photoUrl,
      personalSocials: employee.personalSocials,
      qrUrl: employee.qrUrl,
      documents: [],
      isEmployee: true,
    },
  });
});

export default { ...crud, create, update, remove };
