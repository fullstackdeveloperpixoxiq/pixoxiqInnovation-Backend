import mongoose from 'mongoose';

// Single document holding the AI provider configuration chosen by a superadmin.
// There are NO defaults: until a provider and a model are saved (and pass a live
// validation), the assistant reports a configuration error instead of answering.
// API keys are stored AES-256-GCM encrypted (see ai/crypto.js) and never leave the server.

const statusSchema = new mongoose.Schema(
  {
    ok: { type: Boolean, default: false },
    checkedAt: Date,
    message: { type: String, default: '', maxlength: 1000 },
    latencyMs: Number,
  },
  { _id: false }
);

const targetSchema = new mongoose.Schema(
  {
    provider: { type: String, default: '' },
    model: { type: String, default: '', trim: true, maxlength: 200 },
    baseUrl: { type: String, default: '', trim: true, maxlength: 500 },
    apiKeyEnc: { type: String, default: '', select: false },
    apiKeyLast4: { type: String, default: '' },
    // Embedding vector size detected during validation
    dimensions: Number,
    status: { type: statusSchema, default: () => ({}) },
    updatedAt: Date,
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
  },
  { _id: false }
);

const aiConfigSchema = new mongoose.Schema(
  {
    key: { type: String, default: 'default', unique: true },
    chat: { type: targetSchema, default: () => ({}) },
    embedding: { type: targetSchema, default: () => ({}) },
  },
  { timestamps: true }
);

aiConfigSchema.statics.getSingleton = async function getSingleton({ withSecrets = false } = {}) {
  const query = this.findOne({ key: 'default' });
  if (withSecrets) query.select('+chat.apiKeyEnc +embedding.apiKeyEnc');
  const doc = await query;
  if (doc) return doc;
  try {
    await this.create({ key: 'default' });
  } catch (err) {
    if (err.code !== 11000) throw err; // created concurrently
  }
  return this.getSingleton({ withSecrets });
};

export default mongoose.model('AiConfig', aiConfigSchema);
