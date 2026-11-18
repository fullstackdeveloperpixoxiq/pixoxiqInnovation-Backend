import mongoose from 'mongoose';
import { toJSONPlugin } from './plugins.js';

// Behaviour of the PIXOXIQ AI Assistant (single document). The assistant is disabled
// until a superadmin enables it. Nothing here selects an AI provider or model.
const chatSettingsSchema = new mongoose.Schema(
  {
    key: { type: String, default: 'default', unique: true },
    enabled: { type: Boolean, default: false },
    assistantName: { type: String, trim: true, maxlength: 60, default: 'PIXOXIQ AI Assistant' },
    welcomeMessage: {
      type: String,
      trim: true,
      maxlength: 600,
      default: "Hi! I'm the PIXOXIQ AI Assistant. Ask me about our company, services, projects or how to get in touch.",
    },
    suggestedQuestions: {
      type: [{ type: String, trim: true, maxlength: 120 }],
      default: ['What services does PIXOXIQ offer?', 'How can I contact PIXOXIQ?'],
      validate: [(v) => v.length <= 6, 'At most 6 suggested questions'],
    },
    // Extra guidance from the admins (tone, topics to emphasise). It can never override the
    // built-in grounding and safety rules.
    additionalInstructions: { type: String, trim: true, maxlength: 3000, default: '' },
    // Generation parameters. temperature null = use the provider's own default.
    temperature: { type: Number, min: 0, max: 2, default: null },
    maxOutputTokens: { type: Number, min: 64, max: 8192, default: 1024 },
    // Context management
    historyWindow: { type: Number, min: 2, max: 40, default: 10 },
    retrievalTopK: { type: Number, min: 1, max: 15, default: 6 },
    minRelevance: { type: Number, min: 0, max: 1, default: 0.2 },
    // Abuse limits
    maxMessageLength: { type: Number, min: 100, max: 8000, default: 2000 },
    dailyMessageLimit: { type: Number, min: 1, max: 5000, default: 100 },
    // Conversations older than this are deleted automatically (0 = keep forever)
    retentionDays: { type: Number, min: 0, max: 3650, default: 180 },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
  },
  { timestamps: true }
);

chatSettingsSchema.pre('validate', function clean(next) {
  this.suggestedQuestions = (this.suggestedQuestions || []).filter(Boolean);
  next();
});

chatSettingsSchema.statics.getSingleton = async function getSingleton() {
  const doc = await this.findOne({ key: 'default' });
  if (doc) return doc;
  try {
    return await this.create({ key: 'default' });
  } catch (err) {
    if (err.code === 11000) return this.findOne({ key: 'default' });
    throw err;
  }
};

chatSettingsSchema.plugin(toJSONPlugin);

export default mongoose.model('ChatSettings', chatSettingsSchema);
