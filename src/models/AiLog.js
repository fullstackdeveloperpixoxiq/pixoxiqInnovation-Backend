import mongoose from 'mongoose';
import { toJSONPlugin } from './plugins.js';

export const AI_LOG_SOURCES = ['chat', 'config', 'indexing', 'embedding', 'summary', 'retrieval'];

// Errors and notable events of the AI assistant. Messages are redacted before saving, so
// they never contain API keys. Kept for 90 days.
const aiLogSchema = new mongoose.Schema(
  {
    level: { type: String, enum: ['error', 'warn', 'info'], default: 'error' },
    source: { type: String, enum: AI_LOG_SOURCES, required: true },
    message: { type: String, required: true, maxlength: 2000 },
    code: { type: String, default: '' },
    provider: { type: String, default: '' },
    model: { type: String, default: '' },
    providerStatus: Number,
    context: { type: mongoose.Schema.Types.Mixed },
  },
  { timestamps: true }
);

aiLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });
aiLogSchema.index({ level: 1, createdAt: -1 });

aiLogSchema.plugin(toJSONPlugin);

export default mongoose.model('AiLog', aiLogSchema);
