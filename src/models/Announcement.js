import mongoose from 'mongoose';
import env from '../config/env.js';
import { toJSONPlugin, fileUrl } from './plugins.js';

export const ANNOUNCEMENT_STATUSES = ['draft', 'published', 'scheduled'];
export const ANNOUNCEMENT_CATEGORIES = ['news', 'product', 'event', 'offer', 'update', 'careers'];

// Only http(s), mailto/tel and site-relative links are accepted for the CTA button
const SAFE_URL = /^(https?:\/\/|mailto:|tel:|\/(?!\/)|#)/i;

const announcementSchema = new mongoose.Schema(
  {
    title: { type: String, required: [true, 'Title is required'], trim: true, maxlength: 140 },
    description: { type: String, trim: true, maxlength: 2000, default: '' },
    // StoredFile id (kept in the database so it survives redeploys)
    image: { type: String, default: '' },
    category: { type: String, enum: ANNOUNCEMENT_CATEGORIES, default: 'news' },
    ctaLabel: { type: String, trim: true, maxlength: 40, default: '' },
    ctaUrl: {
      type: String,
      trim: true,
      maxlength: 500,
      default: '',
      validate: [(v) => !v || SAFE_URL.test(v), 'CTA link must start with https://, http://, mailto:, tel: or /'],
    },
    status: { type: String, enum: ANNOUNCEMENT_STATUSES, default: 'draft' },
    // Scheduled announcements go live at publishAt; any announcement stops showing after expiresAt
    publishAt: { type: Date, default: null },
    expiresAt: { type: Date, default: null },
    // Where it is displayed on the website
    showInTopBar: { type: Boolean, default: false },
    showOnHomepage: { type: Boolean, default: true },
    isPinned: { type: Boolean, default: false },
    order: { type: Number, default: 0 },
    publishedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

announcementSchema.index({ status: 1, publishAt: 1 });

announcementSchema.pre('validate', function check(next) {
  if (this.status === 'scheduled' && !this.publishAt) {
    this.invalidate('publishAt', 'Pick a date and time to publish a scheduled announcement');
  }
  if (this.publishAt && this.expiresAt && this.expiresAt <= this.publishAt) {
    this.invalidate('expiresAt', 'Expiry must be after the publish time');
  }
  if (this.ctaLabel && !this.ctaUrl) this.invalidate('ctaUrl', 'Add a link for the button');
  if (this.status === 'published' && !this.publishedAt) this.publishedAt = new Date();
  next();
});

// Filter for announcements visible on the website right now
export const liveFilter = (now = new Date()) => ({
  $and: [
    {
      $or: [
        { status: 'published' },
        { status: 'scheduled', publishAt: { $lte: now } },
      ],
    },
    { $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] },
  ],
});

announcementSchema.virtual('imageUrl').get(function imageUrl() {
  if (!this.image) return null;
  if (mongoose.isValidObjectId(this.image) && !this.image.includes('/')) {
    return `${env.apiPublicUrl}/api/public/files/${this.image}`;
  }
  return fileUrl(this.image);
});

// What the website is showing: live, scheduled (waiting), expired or draft
announcementSchema.virtual('displayState').get(function displayState() {
  const now = new Date();
  if (this.status === 'draft') return 'draft';
  if (this.expiresAt && this.expiresAt <= now) return 'expired';
  if (this.status === 'scheduled' && this.publishAt > now) return 'scheduled';
  return 'live';
});

announcementSchema.plugin(toJSONPlugin);

export default mongoose.model('Announcement', announcementSchema);
