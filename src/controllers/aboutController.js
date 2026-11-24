import About from '../models/About.js';
import StoredFile from '../models/StoredFile.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import env from '../config/env.js';
import { sniffImageType } from '../middleware/upload.js';
import {
  sanitizeAbout,
  defaultAbout,
  collectImages,
  ITEM_SANITIZERS,
  LIST_KEYS,
  MAX_ITEMS,
  newItemId,
} from '../utils/aboutContent.js';

const IMAGE_PURPOSE = 'about/image';
const FILE_URL_PREFIX = `${env.apiPublicUrl}/api/public/files/`;

const log = (msg, extra) => console.log(`[about] ${msg}`, extra ?? '');

// Plain content object without Mongoose internals. Normalize legacy string image fields so
// existing records work with the responsive image editor and public renderer immediately.
const plain = (sub) => {
  if (!sub) return defaultAbout();
  const content = JSON.parse(JSON.stringify(sub.toObject({ transform: false, virtuals: false })));
  const normalize = (image) => typeof image === 'string' ? { src: image, mobileSrc: '', position: 'center' } : image;
  content.hero.image = normalize(content.hero?.image);
  content.intro.image = normalize(content.intro?.image);
  content.visionMission.vision.image = normalize(content.visionMission?.vision?.image);
  content.visionMission.mission.image = normalize(content.visionMission?.mission?.image);
  content.capabilities.items = (content.capabilities?.items || []).map((item) => ({ ...item, image: normalize(item.image) }));
  return content;
};

const adminView = async (doc) => {
  await doc.populate([
    { path: 'updatedBy', select: 'name email' },
    { path: 'publishedBy', select: 'name email' },
  ]);
  const who = (a) => (a ? { id: a.id, name: a.name, email: a.email } : null);
  return {
    draft: plain(doc.draft),
    published: plain(doc.published),
    meta: {
      hasUnpublishedChanges: doc.hasUnpublishedChanges,
      draftUpdatedAt: doc.draftUpdatedAt || null,
      publishedAt: doc.publishedAt || null,
      updatedAt: doc.updatedAt,
      updatedBy: who(doc.updatedBy),
      publishedBy: who(doc.publishedBy),
    },
  };
};

// Deletes uploaded About images that neither the draft nor the published copy still uses.
// Only files older than an hour are removed, so an image uploaded for an unsaved edit survives.
const removeUnusedImages = async (doc) => {
  try {
    const used = new Set(
      [...collectImages(plain(doc.draft)), ...collectImages(plain(doc.published))]
        .filter((u) => u.startsWith(FILE_URL_PREFIX))
        .map((u) => u.slice(FILE_URL_PREFIX.length))
    );
    const cutoff = new Date(Date.now() - 60 * 60 * 1000);
    const stale = await StoredFile.find({ purpose: IMAGE_PURPOSE, createdAt: { $lt: cutoff } }).select('_id').lean();
    const ids = stale.map((f) => f._id.toString()).filter((id) => !used.has(id));
    if (ids.length) {
      await StoredFile.deleteMany({ _id: { $in: ids } });
      log(`removed ${ids.length} unused image(s)`);
    }
  } catch (err) {
    console.error('[about] image cleanup failed', err);
  }
};

const saveDraft = async (doc, content, admin) => {
  doc.draft = content;
  doc.hasUnpublishedChanges = JSON.stringify(content) !== JSON.stringify(plain(doc.published));
  doc.draftUpdatedAt = new Date();
  doc.updatedBy = admin._id;
  await doc.save();
};

// ---------- public ----------

// GET /api/public/about — the published content only
export const getPublicAbout = asyncHandler(async (req, res) => {
  const doc = await About.findOne({ key: 'default' }).select('published publishedAt');
  const data = doc ? plain(doc.published) : defaultAbout();
  // Always revalidate (cheap 304 via ETag) so a new publish shows up immediately;
  // the website itself avoids repeat requests with React Query caching.
  res.set('Cache-Control', 'public, no-cache');
  res.json({ success: true, data: { ...data, publishedAt: doc?.publishedAt || null } });
});

// ---------- admin ----------

// GET /api/about
export const getAbout = asyncHandler(async (req, res) => {
  const doc = await About.getSingleton();
  res.json({ success: true, data: await adminView(doc) });
});

// PUT /api/about — save the draft (body: { content } or the content itself)
export const updateDraft = asyncHandler(async (req, res) => {
  const doc = await About.getSingleton();
  const content = sanitizeAbout(req.body?.content ?? req.body, plain(doc.draft));
  await saveDraft(doc, content, req.admin);
  log(`draft saved by ${req.admin.email}`);
  res.json({ success: true, message: 'Draft saved', data: await adminView(doc) });
});

// POST /api/about/publish — optionally saves `content` first, then makes the draft live
export const publish = asyncHandler(async (req, res) => {
  const doc = await About.getSingleton();
  if (req.body?.content) {
    doc.draft = sanitizeAbout(req.body.content, plain(doc.draft));
    doc.draftUpdatedAt = new Date();
    doc.updatedBy = req.admin._id;
  }
  // Re-validate the stored draft too (e.g. one saved before a rule changed)
  const content = sanitizeAbout(plain(doc.draft));
  doc.draft = content;
  doc.published = content;
  doc.hasUnpublishedChanges = false;
  doc.publishedAt = new Date();
  doc.publishedBy = req.admin._id;
  await doc.save();
  log(`published by ${req.admin.email}`);
  removeUnusedImages(doc);
  res.json({ success: true, message: 'About Us published to the website', data: await adminView(doc) });
});

// POST /api/about/reset — body.target: "published" (discard draft changes) or "defaults"
export const reset = asyncHandler(async (req, res) => {
  const target = req.body?.target || 'published';
  if (!['published', 'defaults'].includes(target)) throw ApiError.badRequest('target must be "published" or "defaults"');
  const doc = await About.getSingleton();
  const content = target === 'defaults' ? defaultAbout() : plain(doc.published);
  await saveDraft(doc, content, req.admin);
  log(`draft reset to ${target} by ${req.admin.email}`);
  removeUnusedImages(doc);
  res.json({
    success: true,
    message: target === 'defaults' ? 'Draft restored to default content' : 'Draft changes discarded',
    data: await adminView(doc),
  });
});

// POST /api/about/upload — one image (field "image"); returns its public URL
export const uploadImage = asyncHandler(async (req, res) => {
  const file = req.file;
  if (!file) throw ApiError.badRequest('Choose an image to upload');
  const type = sniffImageType(file.buffer);
  if (!type) throw ApiError.badRequest('Image must be a valid JPG, PNG, WEBP or AVIF file');
  try {
    const stored = await StoredFile.create({
      data: file.buffer,
      contentType: type,
      size: file.size,
      purpose: IMAGE_PURPOSE,
      filename: (file.originalname || '').slice(0, 200),
    });
    res.status(201).json({
      success: true,
      message: 'Image uploaded',
      data: { id: stored.id, url: `${FILE_URL_PREFIX}${stored.id}`, size: file.size, contentType: type },
    });
  } catch (err) {
    console.error('[about] image upload failed', err);
    throw new ApiError(500, 'Could not save the image, please try again');
  }
});

// ---------- repeatable items (capabilities, pillars, journey) on the draft ----------

const listFor = (req) => {
  const key = LIST_KEYS[req.params.list];
  if (!key) throw ApiError.notFound('Unknown list (use capabilities, pillars or journey)');
  return key;
};

// POST /api/about/:list
export const addItem = asyncHandler(async (req, res) => {
  const key = listFor(req);
  const doc = await About.getSingleton();
  const content = plain(doc.draft);
  if (content[key].items.length >= MAX_ITEMS[key]) throw ApiError.badRequest(`At most ${MAX_ITEMS[key]} items are allowed`);
  const item = ITEM_SANITIZERS[key]({ ...req.body, id: newItemId() }, content[key].items.length);
  content[key].items.push(item);
  await saveDraft(doc, sanitizeAbout(content), req.admin);
  res.status(201).json({ success: true, message: 'Item added', data: await adminView(doc) });
});

// PUT /api/about/:list/:itemId
export const updateItem = asyncHandler(async (req, res) => {
  const key = listFor(req);
  const doc = await About.getSingleton();
  const content = plain(doc.draft);
  const index = content[key].items.findIndex((i) => i.id === req.params.itemId);
  if (index < 0) throw ApiError.notFound('Item not found');
  content[key].items[index] = ITEM_SANITIZERS[key]({ ...content[key].items[index], ...req.body, id: req.params.itemId }, index);
  await saveDraft(doc, sanitizeAbout(content), req.admin);
  res.json({ success: true, message: 'Item updated', data: await adminView(doc) });
});

// DELETE /api/about/:list/:itemId
export const removeItem = asyncHandler(async (req, res) => {
  const key = listFor(req);
  const doc = await About.getSingleton();
  const content = plain(doc.draft);
  const before = content[key].items.length;
  content[key].items = content[key].items.filter((i) => i.id !== req.params.itemId);
  if (content[key].items.length === before) throw ApiError.notFound('Item not found');
  await saveDraft(doc, sanitizeAbout(content), req.admin);
  res.json({ success: true, message: 'Item removed', data: await adminView(doc) });
});

// PATCH /api/about/:list/reorder — body: { ids: [...] } in the new order
export const reorderItems = asyncHandler(async (req, res) => {
  const key = listFor(req);
  const { ids } = req.body || {};
  const doc = await About.getSingleton();
  const content = plain(doc.draft);
  const current = content[key].items;
  if (!Array.isArray(ids) || ids.length !== current.length || !current.every((i) => ids.includes(i.id))) {
    throw ApiError.badRequest('ids must list every item exactly once');
  }
  content[key].items = ids.map((id) => current.find((i) => i.id === id));
  await saveDraft(doc, sanitizeAbout(content), req.admin);
  res.json({ success: true, message: 'Order updated', data: await adminView(doc) });
});
