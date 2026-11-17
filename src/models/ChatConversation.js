import mongoose from 'mongoose';
import { toJSONPlugin } from './plugins.js';

// A chat between a website visitor and the assistant. Visitors are anonymous: they hold a
// random session token and only its SHA-256 hash is stored here, so a conversation can
// only be read by the browser that created it (and by admins).
const chatConversationSchema = new mongoose.Schema(
  {
    visitorHash: { type: String, required: true, index: true, select: false },
    // Short, non-reversible id shown to admins to group conversations of one visitor
    visitorTag: { type: String, default: '' },
    title: { type: String, trim: true, maxlength: 120, default: 'New conversation' },
    messageCount: { type: Number, default: 0 },
    lastMessageAt: { type: Date, default: Date.now, index: true },
    // Rolling summary of messages that dropped out of the history window
    summary: { type: String, default: '', maxlength: 4000 },
    summarizedCount: { type: Number, default: 0 },
    totalInputTokens: { type: Number, default: 0 },
    totalOutputTokens: { type: Number, default: 0 },
    userAgent: { type: String, default: '', select: false },
  },
  { timestamps: true }
);

chatConversationSchema.index({ visitorHash: 1, lastMessageAt: -1 });

chatConversationSchema.plugin(toJSONPlugin);

export default mongoose.model('ChatConversation', chatConversationSchema);
