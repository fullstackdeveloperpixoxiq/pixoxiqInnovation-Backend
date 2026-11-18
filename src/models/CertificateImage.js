import mongoose from 'mongoose';
import env from '../config/env.js';
import { toJSONPlugin, fileUrl } from './plugins.js';

// Real certificate scans attached to one Company Certification (e.g. TUV Certified)
const certificateImageSchema = new mongoose.Schema(
  {
    certificate: { type: mongoose.Schema.Types.ObjectId, ref: 'Certificate', required: [true, 'Certification is required'], index: true },
    title: { type: String, trim: true, maxlength: 120, default: '' },
    // Id of a StoredFile (kept in the database so it survives redeploys)
    image: { type: String, required: [true, 'Certificate image is required'] },
    isActive: { type: Boolean, default: true },
    order: { type: Number, default: 0 },
  },
  { timestamps: true }
);

certificateImageSchema.index({ isActive: 1, order: 1 });

certificateImageSchema.virtual('imageUrl').get(function imageUrl() {
  if (!this.image) return null;
  if (mongoose.isValidObjectId(this.image) && !this.image.includes('/')) {
    return `${env.apiPublicUrl}/api/public/files/${this.image}`;
  }
  return fileUrl(this.image);
});

certificateImageSchema.plugin(toJSONPlugin);

export default mongoose.model('CertificateImage', certificateImageSchema);
