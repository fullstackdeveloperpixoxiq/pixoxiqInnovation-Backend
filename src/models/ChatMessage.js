import mongoose from 'mongoose';
import { toJSONPlugin } from './plugins.js';

const sourceSchema = new mongoose.Schema(
  {
    entry: { type: mongoose.Schema.Types.ObjectId, ref: 'KnowledgeEntry' },
    title: String,
    category: String,
    score: Number,
  },
  { _id: false }
);

const chatMessageSchema = new mongoose.Schema(
  {
    conversation: { type: mongoose.Schema.Types.ObjectId, ref: 'ChatConversation', required: true, index: true },
    visitorHash: { type: String, required: true, select: false },
    role: { type: String, enum: ['user', 'assistant'], required: true },
    content: { type: String, required: true, maxlength: 60000 },
    // Knowledge entries given to the model for this answer
    sources: { type: [sourceSchema], default: undefined },
    provider: String,
    model: String,
    usage: {
      inputTokens: Number,
      outputTokens: Number,
    },
    latencyMs: Number,
    finishReason: String,
    // The visitor stopped the answer before it finished
    interrupted: { type: Boolean, default: false },
    // Produced by "regenerate" (counts towards the visitor's daily limit)
    regenerated: { type: Boolean, default: false },
  },
  { timestamps: true }
);

chatMessageSchema.index({ conversation: 1, createdAt: 1 });
chatMessageSchema.index({ visitorHash: 1, role: 1, createdAt: -1 });
chatMessageSchema.index({ createdAt: -1 });

chatMessageSchema.plugin(toJSONPlugin);

export default mongoose.model('ChatMessage', chatMessageSchema);
