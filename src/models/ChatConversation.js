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
    // Who asked: the logged-in website account (if any) and the email typed into the chat
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    visitorEmail: { type: String, trim: true, lowercase: true, maxlength: 254, default: '' },
    title: { type: String, trim: true, maxlength: 120, default: 'New conversation' },
    messageCount: { type: Number, default: 0 },
    lastMessageAt: { type: Date, default: Date.now, index: true },
    // Rolling summary of messages that dropped out of the history window
    summary: { type: String, default: '', maxlength: 4000 },
    summarizedCount: { type: Number, default: 0 },
    totalInputTokens: { type: Number, default: 0 },
    totalOutputTokens: { type: Number, default: 0 },
    userAgent: { type: String, default: '', select: false },
    // Intent of the latest classified question (JOB_ENQUIRY / WEBSITE_ENQUIRY / AMBIGUOUS)
    category: { type: String, default: '' },
    categoryConfidence: { type: Number, default: null },
    classifiedAt: Date,
    // Admin section: 'job' once a recruitment intent is seen (stays job: the conversation then
    // holds a career enquiry), otherwise 'general'. Classified on the server only.
    queryType: { type: String, enum: ['general', 'job'], default: 'general' },
    // Latest topic of a general conversation (company, services, technology, ...)
    topic: { type: String, default: '' },
    // Admin handling of general conversations
    adminStatus: { type: String, enum: ['open', 'archived'], default: 'open' },
    archivedAt: Date,
    archivedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
    // Email confirmed by OTP (verified visitors only; registered users are linked via `user`)
    verifiedEmail: { type: String, trim: true, lowercase: true, maxlength: 254, default: '' },
  },
  { timestamps: true }
);

chatConversationSchema.index({ visitorHash: 1, lastMessageAt: -1 });
chatConversationSchema.index({ queryType: 1, adminStatus: 1, lastMessageAt: -1 });
chatConversationSchema.index({ queryType: 1, topic: 1 });

chatConversationSchema.plugin(toJSONPlugin);

export default mongoose.model('ChatConversation', chatConversationSchema);
