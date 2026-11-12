import mongoose from 'mongoose';
import slugify from '../utils/slugify.js';
import { toJSONPlugin } from './plugins.js';

const serviceSchema = new mongoose.Schema(
  {
    title: { type: String, required: [true, 'Service title is required'], trim: true, maxlength: 100 },
    slug: {
      type: String,
      unique: true,
      lowercase: true,
      trim: true,
      match: [/^[a-z0-9-]+$/, 'Slug can only contain lowercase letters, numbers and dashes'],
    },
    description: { type: String, required: [true, 'Description is required'], trim: true, maxlength: 600 },
    // Longer copy shown on the service detail page for services without a custom page
    content: { type: String, trim: true, maxlength: 5000, default: '' },
    features: {
      type: [{ type: String, trim: true, maxlength: 60 }],
      default: [],
    },
    // Name of a lucide-react icon (e.g. "Cpu", "Settings")
    icon: { type: String, trim: true, default: 'Cpu' },
    isActive: { type: Boolean, default: true },
    order: { type: Number, default: 0 },
  },
  { timestamps: true }
);

serviceSchema.index({ isActive: 1, order: 1 });

serviceSchema.pre('validate', function setSlug(next) {
  if (!this.slug && this.title) this.slug = slugify(this.title);
  this.features = (this.features || []).filter(Boolean);
  next();
});

serviceSchema.plugin(toJSONPlugin);

export default mongoose.model('Service', serviceSchema);
