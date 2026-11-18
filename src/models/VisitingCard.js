import mongoose from 'mongoose';
import env from '../config/env.js';
import { toJSONPlugin, fileUrl } from './plugins.js';

// Empty string allowed (link not set)
const socialUrl = /^(https?:\/\/.+)?$/i;

// Personal profile links for the "Follow me" section. Empty = hidden.
export const PERSONAL_SOCIALS = ['facebook', 'instagram', 'linkedin', 'twitter', 'github', 'youtube', 'threads', 'telegram', 'tiktok', 'pinterest', 'snapchat', 'behance', 'dribbble', 'medium', 'portfolio'];
const personalSocialsSchema = Object.fromEntries(
  PERSONAL_SOCIALS.map((key) => [
    key,
    { type: String, trim: true, maxlength: 300, match: [socialUrl, `${key} link must start with http:// or https://`], default: '' },
  ])
);

// Single document holding the company visiting card shown at /visiting-card on the website.
// Defaults match the printed card so the page works before anyone edits it.
const visitingCardSchema = new mongoose.Schema(
  {
    name: { type: String, required: [true, 'Name is required'], trim: true, maxlength: 80, default: 'Muhammed Musthafa' },
    designation: { type: String, trim: true, maxlength: 80, default: 'Founder & CEO' },
    company: { type: String, trim: true, maxlength: 120, default: 'Pixoxiq Innovations Pvt. Ltd.' },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      maxlength: 120,
      match: [/^\S+@\S+\.\S+$/, 'Enter a valid email'],
      default: 'info@pixoxiq.com',
    },
    phone: { type: String, trim: true, maxlength: 30, default: '+91 73564 36944' },
    website: { type: String, trim: true, maxlength: 200, default: 'https://www.pixoxiq.com' },
    // Short place name shown under the QR code, e.g. "Malappuram, Kerala"
    location: { type: String, trim: true, maxlength: 120, default: '' },
    // Google Maps link encoded in the QR code
    locationUrl: {
      type: String,
      trim: true,
      maxlength: 1000,
      match: [/^https?:\/\//i, 'Location link must start with http:// or https://'],
      default:
        'https://www.google.com/maps/place/pixoxiq+Innovations+Pvt+Ltd/@10.7743138,76.043856,17z/data=!3m1!4b1!4m6!3m5!1s0x3ba7b93e5bf1d0af:0xa9a89e70c7111abe!8m2!3d10.7743138!4d76.043856!16s%2Fg%2F11wqy_kk2b',
    },
    // WhatsApp number. The website falls back to `phone` when empty.
    whatsapp: { type: String, trim: true, maxlength: 30, default: '' },
    // e.g. "Mon - Sat: 10.00am - 06.00pm"
    workingHours: { type: String, trim: true, maxlength: 120, default: 'Mon - Sat: 09.00am - 06.00pm' },
    // Text shown in the "About Us" tab
    about: { type: String, trim: true, maxlength: 3000, default: '' },
    // Link encoded in the visiting card QR code. Empty = the website uses its own /visiting-card URL.
    qrUrl: {
      type: String,
      trim: true,
      maxlength: 500,
      match: [/^(https?:\/\/.+)?$/i, 'QR link must start with http:// or https://'],
      default: '',
    },
    // Links shown in the "Documents" tab (brochure, company profile...)
    documents: {
      type: [
        {
          _id: false,
          title: { type: String, trim: true, required: [true, 'Document title is required'], maxlength: 120 },
          url: {
            type: String,
            trim: true,
            required: [true, 'Document link is required'],
            maxlength: 1000,
            match: [/^https?:\/\//i, 'Document link must start with http:// or https://'],
          },
        },
      ],
      default: [],
      validate: [(v) => v.length <= 20, 'At most 20 documents'],
    },
    // Social profile links shown as icons. Empty = icon hidden.
    socials: {
      instagram: { type: String, trim: true, maxlength: 300, match: [socialUrl, 'Instagram link must start with http:// or https://'], default: 'https://www.instagram.com/pixoxiq__/' },
      facebook: { type: String, trim: true, maxlength: 300, match: [socialUrl, 'Facebook link must start with http:// or https://'], default: '' },
      linkedin: {
        type: String,
        trim: true,
        maxlength: 300,
        match: [socialUrl, 'LinkedIn link must start with http:// or https://'],
        default: 'https://www.linkedin.com/company/pixoxiq-innovations-pvt-ltd/home/',
      },
      twitter: { type: String, trim: true, maxlength: 300, match: [socialUrl, 'X (Twitter) link must start with http:// or https://'], default: '' },
      youtube: { type: String, trim: true, maxlength: 300, match: [socialUrl, 'YouTube link must start with http:// or https://'], default: '' },
    },
    personalSocials: personalSocialsSchema,
    // Profile picture: id of a StoredFile (kept in the database so it survives redeploys).
    // Older records may hold a relative path inside /uploads instead.
    photo: { type: String, default: '' },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
  },
  { timestamps: true }
);

// The StoredFile id changes with every upload, so a replaced photo always gets a new URL
visitingCardSchema.virtual('photoUrl').get(function photoUrl() {
  if (!this.photo) return null;
  if (mongoose.isValidObjectId(this.photo) && !this.photo.includes('/')) {
    return `${env.apiPublicUrl}/api/public/files/${this.photo}`;
  }
  return fileUrl(this.photo);
});

// Returns the one card, creating it with defaults on first access
visitingCardSchema.statics.getSingleton = async function getSingleton() {
  return (await this.findOne()) || this.create({});
};

visitingCardSchema.plugin(toJSONPlugin);

export default mongoose.model('VisitingCard', visitingCardSchema);
