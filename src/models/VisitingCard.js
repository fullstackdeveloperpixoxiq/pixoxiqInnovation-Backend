import mongoose from 'mongoose';
import env from '../config/env.js';
import { toJSONPlugin, fileUrl } from './plugins.js';

const URL_RULE = [/^$|^https?:\/\/\S+$/i, 'Enter a valid URL starting with http:// or https://'];

// Singleton document: there is exactly one visiting card page on the website.
const visitingCardSchema = new mongoose.Schema(
  {
    key: { type: String, default: 'main', unique: true, immutable: true },
    name: { type: String, trim: true, maxlength: 120, default: '' },
    designation: { type: String, trim: true, maxlength: 120, default: '' },
    company: { type: String, trim: true, maxlength: 160, default: '' },
    website: { type: String, trim: true, maxlength: 500, default: '', match: URL_RULE },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      maxlength: 160,
      default: '',
      match: [/^$|^\S+@\S+\.\S+$/, 'Enter a valid email'],
    },
    phone: {
      type: String,
      trim: true,
      maxlength: 40,
      default: '',
      match: [/^$|^\+?[0-9][0-9\s-]{6,19}$/, 'Enter a valid mobile number'],
    },
    // Office address in words (used for labels); the map link is locationUrl
    location: { type: String, trim: true, maxlength: 300, default: '' },
    locationUrl: { type: String, trim: true, maxlength: 1000, default: '', match: URL_RULE },
    // Relative paths inside /uploads (e.g. "visiting-card/123.png") or absolute URLs
    frontImage: { type: String, default: '' },
    backImage: { type: String, default: '' },
    // Founder photo drawn over the photo area of the front image: id of a StoredFile,
    // or blank to keep the photo printed in the card image
    profilePhoto: { type: String, default: '' },
  },
  { timestamps: true }
);

visitingCardSchema.virtual('frontImageUrl').get(function frontImageUrl() {
  return fileUrl(this.frontImage);
});
visitingCardSchema.virtual('backImageUrl').get(function backImageUrl() {
  return fileUrl(this.backImage);
});
// The id changes with every upload, so a replaced photo always gets a new URL
visitingCardSchema.virtual('profilePhotoUrl').get(function profilePhotoUrl() {
  return this.profilePhoto ? `${env.apiPublicUrl}/api/public/files/${this.profilePhoto}` : null;
});

visitingCardSchema.plugin(toJSONPlugin);

export default mongoose.model('VisitingCard', visitingCardSchema);
