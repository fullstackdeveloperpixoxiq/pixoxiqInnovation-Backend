import VisitingCard from '../models/VisitingCard.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import StoredFile from '../models/StoredFile.js';
import { removeUpload, sniffImageType } from '../middleware/upload.js';
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

// Deletes a photo that is no longer used: a StoredFile id, or a legacy path in /uploads
const removePhoto = (value) => {
  if (!value) return;
  if (value.includes('/')) return removeUpload(value);
  StoredFile.deleteOne({ _id: value }).catch(() => {});
};

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
  // The photo arrives in memory (see routes/visitingCardRoutes.js) and is stored in the database
  const photoFile = req.file;
  const photoType = photoFile && sniffImageType(photoFile.buffer);
  if (photoFile && !photoType) throw ApiError.badRequest('Profile picture must be a valid JPG, PNG or WEBP image');

  let card;
  let previousPhoto;
  let newPhoto;

  try {
    if (photoFile) {
      const stored = await StoredFile.create({
        data: photoFile.buffer,
        contentType: photoType,
        size: photoFile.size,
        purpose: 'visiting-card/profile-photo',
      });
      newPhoto = stored.id;
    }

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
    removePhoto(newPhoto);
    throw err;
  }

  if (previousPhoto && previousPhoto !== card.photo) removePhoto(previousPhoto);
  await card.populate('updatedBy', 'name');
  res.json({ success: true, message: 'Visiting card updated', data: card });
});
