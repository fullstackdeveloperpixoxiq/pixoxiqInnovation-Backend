import mongoose from 'mongoose';
import env from '../config/env.js';
import { toJSONPlugin, fileUrl } from './plugins.js';
import { PERSONAL_SOCIALS } from './VisitingCard.js';

const socialUrl = /^(https?:\/\/.+)?$/i;

// An employee's digital visiting card, shown at /visiting-card/<slug> on the website.
// Phone, WhatsApp, location, company and About come from the company visiting card.
const employeeSchema = new mongoose.Schema(
  {
    name: { type: String, required: [true, 'Name is required'], trim: true, maxlength: 80 },
    designation: { type: String, trim: true, maxlength: 80, default: '' },
    department: { type: String, trim: true, maxlength: 80, default: '' },
    // Empty = the company email is shown
    email: {
      type: String,
      trim: true,
      lowercase: true,
      maxlength: 120,
      match: [/^(\S+@\S+\.\S+)?$/, 'Enter a valid email'],
      default: '',
    },
    // Hidden URL path chosen by the admin, e.g. "sales" or "sales-1"
    slug: {
      type: String,
      required: [true, 'URL path is required'],
      unique: true,
      trim: true,
      lowercase: true,
      maxlength: 60,
      match: [/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'URL path can only use lowercase letters, numbers and single hyphens (e.g. sales-1)'],
    },
    // Link the QR opens. Empty = this employee's own card link (/visiting-card/<slug>)
    qrUrl: { type: String, trim: true, maxlength: 500, match: [socialUrl, 'QR link must start with http:// or https://'], default: '' },
    personalSocials: Object.fromEntries(
      PERSONAL_SOCIALS.map((key) => [
        key,
        { type: String, trim: true, maxlength: 300, match: [socialUrl, `${key} link must start with http:// or https://`], default: '' },
      ])
    ),
    // Id of a StoredFile (kept in the database so it survives redeploys)
    photo: { type: String, default: '' },
    isActive: { type: Boolean, default: true },
    order: { type: Number, default: 0 },
  },
  { timestamps: true }
);

employeeSchema.virtual('photoUrl').get(function photoUrl() {
  if (!this.photo) return null;
  if (mongoose.isValidObjectId(this.photo) && !this.photo.includes('/')) {
    return `${env.apiPublicUrl}/api/public/files/${this.photo}`;
  }
  return fileUrl(this.photo);
});

employeeSchema.plugin(toJSONPlugin);

export default mongoose.model('Employee', employeeSchema);
