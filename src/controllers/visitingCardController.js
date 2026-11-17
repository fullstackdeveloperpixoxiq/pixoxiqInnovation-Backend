import VisitingCard from '../models/VisitingCard.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import { removeUpload } from '../middleware/upload.js';
import { pickFields } from './crudFactory.js';

const FIELDS = [
  'name',
  'designation',
  'company',
  'email',
  'phone',
  'whatsapp',
  'website',
  'location',
  'locationUrl',
  'workingHours',
  'about',
  'qrUrl',
];

// Fields the public website needs (no audit info or storage paths)
const toPublic = (card) => {
  const { updatedBy, createdAt, photo, ...rest } = card.toJSON();
  return rest;
};

const uploadedPath = (file) => (file ? `visiting-card/${file.filename}` : undefined);

// The admin form is multipart (it may carry a photo), so documents arrive as a JSON string
const parseDocuments = (raw) => {
  if (raw === undefined) return undefined;
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error();
    return parsed.map((d) => ({ title: d?.title, url: d?.url }));
  } catch {
    throw ApiError.badRequest('Documents must be a JSON array');
  }
};

const SOCIALS = ['instagram', 'facebook', 'linkedin', 'twitter', 'youtube'];

// Socials also arrive as a JSON string from the multipart form
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
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw ApiError.badRequest('Social links must be a JSON object');
  }
  return Object.fromEntries(SOCIALS.map((key) => [key, typeof parsed[key] === 'string' ? parsed[key] : '']));
};

export const getPublicCard = asyncHandler(async (req, res) => {
  const card = await VisitingCard.getSingleton();
  res.json({ success: true, data: toPublic(card) });
});

export const getCard = asyncHandler(async (req, res) => {
  const card = await VisitingCard.getSingleton();
  await card.populate('updatedBy', 'name');
  res.json({ success: true, data: card });
});

// Superadmin only
export const updateCard = asyncHandler(async (req, res) => {
  const newPhoto = uploadedPath(req.file);
  if (req.file?.mimetype === 'application/pdf') {
    removeUpload(newPhoto);
    throw ApiError.badRequest('Profile picture must be an image (JPG, PNG, WEBP or SVG)');
  }
  let card;
  let previousPhoto;

  try {
    card = await VisitingCard.getSingleton();
    previousPhoto = card.photo;

    card.set(pickFields(req.body, FIELDS));
    const documents = parseDocuments(req.body.documents);
    if (documents) card.documents = documents;
    const socials = parseSocials(req.body.socials);
    if (socials) card.socials = socials;

    if (newPhoto) card.photo = newPhoto;
    else if (req.body.removePhoto === 'true') card.photo = '';

    card.updatedBy = req.admin._id;
    await card.save();
  } catch (err) {
    if (newPhoto) removeUpload(newPhoto);
    throw err;
  }

  if (previousPhoto && previousPhoto !== card.photo) removeUpload(previousPhoto);
  await card.populate('updatedBy', 'name');
  res.json({ success: true, message: 'Visiting card updated', data: card });
});
