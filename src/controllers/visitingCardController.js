import VisitingCard, { PERSONAL_SOCIALS } from '../models/VisitingCard.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import StoredFile from '../models/StoredFile.js';
import { removeUpload, sniffImageType, sniffDocumentType } from '../middleware/upload.js';
import env from '../config/env.js';
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

// The admin form is multipart (it may carry files), so documents arrive as a JSON string.
// Each item is either an existing document ({ title, file, filename, url }) or a new upload
// ({ title, upload: n }) where n is the index of the file in the `documentFiles` field.
const parseDocuments = (raw) => {
  if (raw === undefined) return undefined;
  let parsed = raw;
  try {
    if (typeof raw === 'string') parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error();
  } catch {
    throw ApiError.badRequest('Documents must be a JSON array');
  }
  return parsed.map((d) => ({
    title: d?.title,
    upload: Number.isInteger(d?.upload) ? d.upload : undefined,
    file: typeof d?.file === 'string' ? d.file : '',
    url: typeof d?.url === 'string' ? d.url : '',
  }));
};

const storedFileUrl = (id) => `${env.apiPublicUrl}/api/public/files/${id}`;

// Saves the uploaded brochure files; returns their StoredFile records in upload order
const storeDocumentFiles = async (files = [], created) => {
  const checked = files.map((f) => {
    const type = sniffDocumentType(f.buffer, f.originalname);
    if (!type) throw ApiError.badRequest(`"${f.originalname}" must be a valid PDF, DOCX, JPG, PNG or WEBP file`);
    return { f, type };
  });
  const stored = [];
  for (const { f, type } of checked) {
    const doc = await StoredFile.create({
      data: f.buffer,
      contentType: type,
      size: f.size,
      purpose: 'visiting-card/document',
      filename: (f.originalname || '').slice(0, 200),
    });
    created.push(doc.id);
    stored.push(doc);
  }
  return stored;
};

// Builds the saved document list: new uploads get their stored file, existing ones keep
// what is already on the card (the client cannot point a document at an arbitrary file)
const resolveDocuments = (items, stored, previous) =>
  items.map((d) => {
    if (d.upload !== undefined) {
      const file = stored[d.upload];
      if (!file) throw ApiError.badRequest(`File missing for document "${d.title || ''}"`);
      return { title: d.title, file: file.id, filename: file.filename, url: storedFileUrl(file.id) };
    }
    const existing = previous.find((p) => (d.file ? p.file === d.file : !p.file && p.url === d.url));
    if (!existing) throw ApiError.badRequest(`Choose a file for document "${d.title || ''}"`);
    return { title: d.title, file: existing.file, filename: existing.filename, url: existing.url };
  });

const SOCIALS = ['instagram', 'facebook', 'linkedin', 'twitter', 'youtube'];

// Socials also arrive as a JSON string from the multipart form
const parseSocials = (raw, keys = SOCIALS) => {
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
  return Object.fromEntries(keys.map((key) => [key, typeof parsed[key] === 'string' ? parsed[key] : '']));
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
  const photoFile = req.files?.photo?.[0];
  const documentFiles = req.files?.documentFiles ?? [];
  const photoType = photoFile && sniffImageType(photoFile.buffer);
  if (photoFile && !photoType) throw ApiError.badRequest('Profile picture must be a valid JPG, PNG or WEBP image');

  let card;
  let previousPhoto;
  let newPhoto;
  let previousDocFiles = [];
  const createdDocFiles = [];

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
    if (documents) {
      const stored = await storeDocumentFiles(documentFiles, createdDocFiles);
      const previous = card.documents.map((d) => d.toObject());
      previousDocFiles = previous.map((d) => d.file).filter(Boolean);
      card.documents = resolveDocuments(documents, stored, previous);
    }
    const socials = parseSocials(req.body.socials);
    if (socials) card.socials = socials;
    const personalSocials = parseSocials(req.body.personalSocials, PERSONAL_SOCIALS);
    if (personalSocials) card.personalSocials = personalSocials;

    if (newPhoto) card.photo = newPhoto;
    else if (req.body.removePhoto === 'true') card.photo = '';

    card.updatedBy = req.admin._id;
    await card.save();
  } catch (err) {
    removePhoto(newPhoto);
    createdDocFiles.forEach(removePhoto);
    throw err;
  }

  // Delete brochure files that were removed or replaced
  const keptDocFiles = new Set(card.documents.map((d) => d.file).filter(Boolean));
  previousDocFiles.filter((id) => !keptDocFiles.has(id)).forEach(removePhoto);

  if (previousPhoto && previousPhoto !== card.photo) removePhoto(previousPhoto);
  await card.populate('updatedBy', 'name');
  res.json({ success: true, message: 'Visiting card updated', data: card });
});
