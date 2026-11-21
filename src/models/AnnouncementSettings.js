import mongoose from 'mongoose';
import { toJSONPlugin } from './plugins.js';

// Display settings for announcements and the newsletter form (single document)
const settingsSchema = new mongoose.Schema(
  {
    key: { type: String, default: 'default', unique: true },
    topBarEnabled: { type: Boolean, default: true },
    topBarDismissible: { type: Boolean, default: true },
    homepageEnabled: { type: Boolean, default: true },
    homepageTitle: { type: String, trim: true, maxlength: 80, default: 'Latest Announcements' },
    homepageSubtitle: {
      type: String,
      trim: true,
      maxlength: 200,
      default: 'News, product launches and updates from PIXOXIQ.',
    },
    homepageLimit: { type: Number, min: 1, max: 12, default: 3 },
    footerNewsletterEnabled: { type: Boolean, default: true },
    newsletterTitle: { type: String, trim: true, maxlength: 80, default: 'Stay in the loop' },
    newsletterText: {
      type: String,
      trim: true,
      maxlength: 200,
      default: 'Get product launches, manufacturing insights and company news in your inbox.',
    },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
  },
  { timestamps: true }
);

settingsSchema.statics.getSingleton = async function getSingleton() {
  const doc = await this.findOne({ key: 'default' });
  if (doc) return doc;
  try {
    return await this.create({ key: 'default' });
  } catch (err) {
    if (err.code === 11000) return this.findOne({ key: 'default' });
    throw err;
  }
};

settingsSchema.plugin(toJSONPlugin);

export default mongoose.model('AnnouncementSettings', settingsSchema);
