import Announcement, { ANNOUNCEMENT_STATUSES, ANNOUNCEMENT_CATEGORIES, liveFilter } from '../models/Announcement.js';
import AnnouncementSettings from '../models/AnnouncementSettings.js';
import StoredFile from '../models/StoredFile.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import { sniffImageType } from '../middleware/upload.js';
import { paginate } from '../utils/queryBuilder.js';
import crudFactory, { pickFields } from './crudFactory.js';

const FIELDS = [
  'title',
  'description',
  'category',
  'ctaLabel',
  'ctaUrl',
  'status',
  'publishAt',
  'expiresAt',
  'showInTopBar',
  'showOnHomepage',
  'isPinned',
  'order',
];

const SETTINGS_FIELDS = [
  'topBarEnabled',
  'topBarDismissible',
  'homepageEnabled',
  'homepageTitle',
  'homepageSubtitle',
  'homepageLimit',
  'footerNewsletterEnabled',
  'newsletterTitle',
  'newsletterText',
];

const crud = crudFactory(Announcement, {
  name: 'Announcement',
  fields: FIELDS,
  searchFields: ['title', 'description'],
  filterFields: ['status', 'category'],
  defaultSort: '-createdAt',
});

// Empty strings from multipart forms clear optional dates
const normalise = (data) => {
  ['publishAt', 'expiresAt'].forEach((key) => {
    if (data[key] === '') data[key] = null;
  });
  return data;
};

// Image is kept in the database (survives redeploys). Returns the StoredFile id.
const storeImage = async (file) => {
  if (!file) return undefined;
  const contentType = sniffImageType(file.buffer);
  if (!contentType) throw ApiError.badRequest('Image must be a valid JPG, PNG or WEBP file');
  const stored = await StoredFile.create({
    data: file.buffer,
    contentType,
    size: file.size,
    purpose: 'announcement/image',
  });
  return stored.id;
};

const removeImage = (value) => {
  if (!value || value.includes('/')) return;
  StoredFile.deleteOne({ _id: value }).catch(() => {});
};

// ---------- Admin ----------

const list = asyncHandler(async (req, res) => {
  const { items, pagination } = await paginate(Announcement, req.query, {
    searchFields: ['title', 'description'],
    filterFields: ['status', 'category'],
    defaultSort: '-createdAt',
  });
  const grouped = await Announcement.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]);
  const counts = Object.fromEntries(ANNOUNCEMENT_STATUSES.map((s) => [s, 0]));
  grouped.forEach((g) => {
    counts[g._id] = g.count;
  });
  res.json({ success: true, data: items, pagination, counts });
});

const create = asyncHandler(async (req, res) => {
  const data = normalise(pickFields(req.body, FIELDS));
  const image = await storeImage(req.file);
  if (image) data.image = image;
  try {
    const doc = await Announcement.create(data);
    res.status(201).json({ success: true, message: 'Announcement created', data: doc });
  } catch (err) {
    removeImage(image);
    throw err;
  }
});

const update = asyncHandler(async (req, res) => {
  const doc = await Announcement.findById(req.params.id);
  if (!doc) throw ApiError.notFound('Announcement not found');

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
  res.json({ success: true, message: 'Announcement updated', data: doc });
});

const remove = asyncHandler(async (req, res) => {
  const doc = await Announcement.findByIdAndDelete(req.params.id);
  if (!doc) throw ApiError.notFound('Announcement not found');
  removeImage(doc.image);
  res.json({ success: true, message: 'Announcement deleted', data: { id: doc.id } });
});

// Body: { status: 'draft' | 'published' } – quick publish / unpublish from the list
const setStatus = asyncHandler(async (req, res) => {
  const { status } = req.body;
  if (!['draft', 'published'].includes(status)) throw ApiError.badRequest('Invalid status');
  const doc = await Announcement.findById(req.params.id);
  if (!doc) throw ApiError.notFound('Announcement not found');
  doc.status = status;
  if (status === 'published') {
    doc.publishedAt = new Date();
    // Publishing now overrides an old expiry that would hide it immediately
    if (doc.expiresAt && doc.expiresAt <= new Date()) doc.expiresAt = null;
  }
  await doc.save();
  res.json({ success: true, message: status === 'published' ? 'Announcement published' : 'Moved to drafts', data: doc });
});

const getSettings = asyncHandler(async (req, res) => {
  const settings = await AnnouncementSettings.getSingleton();
  res.json({ success: true, data: settings, meta: { categories: ANNOUNCEMENT_CATEGORIES } });
});

const updateSettings = asyncHandler(async (req, res) => {
  const settings = await AnnouncementSettings.getSingleton();
  settings.set(pickFields(req.body, SETTINGS_FIELDS));
  settings.updatedBy = req.admin._id;
  await settings.save();
  res.json({ success: true, message: 'Display settings saved', data: settings });
});

// ---------- Public ----------

const PUBLIC_FIELDS = 'title description image category ctaLabel ctaUrl isPinned publishAt publishedAt createdAt';

const toPublic = (doc) => ({
  id: doc.id,
  title: doc.title,
  description: doc.description,
  imageUrl: doc.imageUrl,
  category: doc.category,
  ctaLabel: doc.ctaLabel,
  ctaUrl: doc.ctaUrl,
  isPinned: doc.isPinned,
  date: doc.publishAt || doc.publishedAt || doc.createdAt,
});

// Everything the website needs in one request: display flags + top bar + homepage items
const getPublic = asyncHandler(async (req, res) => {
  const settings = await AnnouncementSettings.getSingleton();
  const sort = { isPinned: -1, order: 1, publishAt: -1, publishedAt: -1, createdAt: -1 };
  const live = liveFilter();

  const [topBar, homepage] = await Promise.all([
    settings.topBarEnabled
      ? Announcement.find({ ...live, showInTopBar: true }).select(PUBLIC_FIELDS).sort(sort).limit(5)
      : [],
    settings.homepageEnabled
      ? Announcement.find({ ...live, showOnHomepage: true }).select(PUBLIC_FIELDS).sort(sort).limit(settings.homepageLimit)
      : [],
  ]);

  res.set('Cache-Control', 'public, max-age=60');
  res.json({
    success: true,
    data: {
      settings: {
        topBarEnabled: settings.topBarEnabled,
        topBarDismissible: settings.topBarDismissible,
        homepageEnabled: settings.homepageEnabled,
        homepageTitle: settings.homepageTitle,
        homepageSubtitle: settings.homepageSubtitle,
        footerNewsletterEnabled: settings.footerNewsletterEnabled,
        newsletterTitle: settings.newsletterTitle,
        newsletterText: settings.newsletterText,
      },
      topBar: topBar.map(toPublic),
      homepage: homepage.map(toPublic),
    },
  });
});

export default { ...crud, list, create, update, remove, setStatus, getSettings, updateSettings, getPublic };
