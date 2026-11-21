import mongoose from 'mongoose';
import { toJSONPlugin } from './plugins.js';
import { defaultAbout } from '../utils/aboutContent.js';

// Website "About Us" section (single document). Admins edit `draft`; publishing copies it to
// `published`, which is the only copy the public website reads. Content is sanitised by
// utils/aboutContent.js before it is saved; the schema below documents and enforces the shape.
const { Schema } = mongoose;
const str = (max) => ({ type: String, trim: true, maxlength: max, default: '' });
const opts = { _id: false };

const ctaSchema = new Schema({ label: str(80), url: str(500) }, opts);
const panelSchema = new Schema({ heading: str(80), quote: str(300), description: str(1200), image: str(500) }, opts);

const contentSchema = new Schema(
  {
    sections: {
      hero: { type: Boolean, default: true },
      intro: { type: Boolean, default: true },
      capabilities: { type: Boolean, default: true },
      visionMission: { type: Boolean, default: true },
      pillars: { type: Boolean, default: true },
      journey: { type: Boolean, default: true },
      cta: { type: Boolean, default: true },
    },
    hero: {
      eyebrow: str(80),
      headline: str(160),
      highlight: str(160),
      intro: str(1200),
      image: str(500),
      primaryCta: { type: ctaSchema, default: () => ({}) },
      secondaryCta: { type: ctaSchema, default: () => ({}) },
    },
    intro: {
      eyebrow: str(80),
      heading: str(160),
      highlight: str(160),
      description: str(1200),
      manufacturing: str(1200),
      oem: str(1200),
      makeInIndia: str(1200),
      image: str(500),
      stats: [new Schema({ id: str(40), value: str(40), label: str(80) }, opts)],
      highlights: [str(80)],
    },
    capabilities: {
      eyebrow: str(80),
      heading: str(160),
      highlight: str(160),
      description: str(1200),
      items: [
        new Schema(
          { id: str(40), title: str(120), description: str(1200), icon: str(40), image: str(500) },
          opts
        ),
      ],
    },
    visionMission: {
      eyebrow: str(80),
      heading: str(160),
      highlight: str(160),
      vision: { type: panelSchema, default: () => ({}) },
      mission: { type: panelSchema, default: () => ({}) },
    },
    pillars: {
      eyebrow: str(80),
      heading: str(160),
      highlight: str(160),
      description: str(1200),
      // Array position is the display order
      items: [new Schema({ id: str(40), title: str(80), subtitle: str(120), description: str(1200), icon: str(40) }, opts)],
    },
    journey: {
      eyebrow: str(80),
      heading: str(160),
      highlight: str(160),
      description: str(1200),
      items: [new Schema({ id: str(40), title: str(80), description: str(1200), icon: str(40) }, opts)],
    },
    cta: { heading: str(160), description: str(1200), buttonLabel: str(80), buttonUrl: str(500) },
  },
  opts
);

const aboutSchema = new Schema(
  {
    key: { type: String, default: 'default', unique: true },
    draft: { type: contentSchema, default: defaultAbout },
    published: { type: contentSchema, default: defaultAbout },
    // True while the draft differs from what is live
    hasUnpublishedChanges: { type: Boolean, default: false },
    draftUpdatedAt: { type: Date },
    publishedAt: { type: Date },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'Admin' },
    publishedBy: { type: Schema.Types.ObjectId, ref: 'Admin' },
  },
  { timestamps: true }
);

aboutSchema.statics.getSingleton = async function getSingleton() {
  const doc = await this.findOne({ key: 'default' });
  if (doc) return doc;
  try {
    return await this.create({ key: 'default' });
  } catch (err) {
    if (err.code === 11000) return this.findOne({ key: 'default' });
    throw err;
  }
};

aboutSchema.plugin(toJSONPlugin);

export default mongoose.model('About', aboutSchema);
