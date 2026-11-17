import mongoose from 'mongoose';
import { toJSONPlugin } from './plugins.js';

export const KNOWLEDGE_STATUSES = ['pending', 'processing', 'indexed', 'failed'];
export const KNOWLEDGE_SOURCES = ['manual', 'file', 'website'];

// Suggested categories shown in the admin panel. Admins can also type their own.
export const KNOWLEDGE_CATEGORIES = [
  'Company profile',
  'Products & services',
  'Projects & solutions',
  'Technologies & capabilities',
  'Business operations',
  'FAQ',
  'Contact information',
  'Careers',
  'Certifications',
];

// One piece of verified company information. Its text is split into KnowledgeChunks
// (with embeddings) by the indexer; the chatbot answers only from those chunks.
const knowledgeEntrySchema = new mongoose.Schema(
  {
    title: { type: String, required: [true, 'Title is required'], trim: true, maxlength: 200 },
    category: { type: String, required: [true, 'Category is required'], trim: true, maxlength: 80 },
    // Full plain text (typed by an admin or extracted from an uploaded document)
    content: {
      type: String,
      required: [true, 'Content is required'],
      maxlength: [1000000, 'Content is too long (max 1,000,000 characters)'],
      select: false,
    },
    contentLength: { type: Number, default: 0 },
    contentHash: { type: String, default: '' },
    sourceType: { type: String, enum: KNOWLEDGE_SOURCES, default: 'manual' },
    // For entries generated from website content, e.g. "service:<id>"
    sourceRef: { type: String, default: '', index: true },
    file: {
      name: { type: String, trim: true, maxlength: 255 },
      mimeType: String,
      size: Number,
    },
    isActive: { type: Boolean, default: true },
    status: { type: String, enum: KNOWLEDGE_STATUSES, default: 'pending' },
    error: { type: String, default: '', maxlength: 1000 },
    chunkCount: { type: Number, default: 0 },
    // "provider:model" used for the chunk vectors ('' = keyword search only)
    embeddingKey: { type: String, default: '' },
    indexedAt: Date,
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
  },
  { timestamps: true }
);

knowledgeEntrySchema.index({ category: 1, updatedAt: -1 });
knowledgeEntrySchema.index({ status: 1 });

knowledgeEntrySchema.plugin(toJSONPlugin);

export default mongoose.model('KnowledgeEntry', knowledgeEntrySchema);
