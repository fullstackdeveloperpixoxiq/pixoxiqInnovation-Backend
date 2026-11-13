import mongoose from 'mongoose';
import { toJSONPlugin } from './plugins.js';

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
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
  },
  { timestamps: true }
);

// Returns the one card, creating it with defaults on first access
visitingCardSchema.statics.getSingleton = async function getSingleton() {
  return (await this.findOne()) || this.create({});
};

visitingCardSchema.plugin(toJSONPlugin);

export default mongoose.model('VisitingCard', visitingCardSchema);
