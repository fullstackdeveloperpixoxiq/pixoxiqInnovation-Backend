import mongoose from 'mongoose';
import { trackChanges } from '../utils/changeTracker.js';
import env from '../config/env.js';
import { toJSONPlugin, fileUrl, LUCIDE_ICON_DEFAULT } from './plugins.js';

const certificateSchema = new mongoose.Schema(
  {
    title: { type: String, required: [true, 'Certificate title is required'], trim: true, maxlength: 120 },
    subtitle: { type: String, trim: true, maxlength: 120, default: '' },
    description: { type: String, trim: true, maxlength: 1000, default: '' },
    issuer: { type: String, trim: true, maxlength: 120, default: '' },
    credentialId: { type: String, trim: true, maxlength: 120, default: '' },
    credentialUrl: { type: String, trim: true, maxlength: 500, default: '' },
    icon: { type: String, trim: true, default: LUCIDE_ICON_DEFAULT },
    // Id of a StoredFile (kept in the database so it survives redeploys). Older records may
    // hold a relative path inside /uploads (e.g. "certificates/123.png") or an absolute URL.
    image: { type: String, default: '' },
    issueDate: Date,
    expiryDate: Date,
    isActive: { type: Boolean, default: true },
    order: { type: Number, default: 0 },
  },
  { timestamps: true }
);

certificateSchema.index({ isActive: 1, order: 1 });

// New uploads hold a StoredFile id (kept in the database); older ones a path in /uploads
certificateSchema.virtual('imageUrl').get(function imageUrl() {
  if (!this.image) return null;
  if (mongoose.isValidObjectId(this.image) && !this.image.includes('/')) {
    return `${env.apiPublicUrl}/api/public/files/${this.image}`;
  }
  return fileUrl(this.image);
});

certificateSchema.virtual('isExpired').get(function isExpired() {
  return Boolean(this.expiryDate && this.expiryDate < new Date());
});

certificateSchema.plugin(toJSONPlugin);
// The AI assistant reads this content live: any change refreshes its company data
trackChanges(certificateSchema);

export default mongoose.model('Certificate', certificateSchema);
