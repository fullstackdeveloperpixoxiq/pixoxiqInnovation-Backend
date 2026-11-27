import mongoose from 'mongoose';
import { toJSONPlugin } from './plugins.js';

// One entry per Odoo Recruitment sync attempt of a chatbot job enquiry. Holds ids, outcome
// and a redacted error only: never credentials, CV contents or candidate details.
const syncLogSchema = new mongoose.Schema(
  {
    enquiry: { type: mongoose.Schema.Types.ObjectId, ref: 'ChatEnquiry', required: true },
    attempt: { type: Number, required: true },
    // created / updated / linked (an existing applicant matched) / failed / requires_attention
    outcome: { type: String, required: true },
    trigger: { type: String, enum: ['submit', 'auto', 'manual', 'update'], default: 'auto' },
    admin: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
    applicantId: { type: Number, default: null },
    attachmentId: { type: Number, default: null },
    error: { type: String, maxlength: 1000, default: '' },
    nextRetryAt: Date,
    durationMs: Number,
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

syncLogSchema.index({ enquiry: 1, createdAt: -1 });
syncLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 400 * 24 * 60 * 60 });

syncLogSchema.plugin(toJSONPlugin);

export default mongoose.model('ChatEnquirySyncLog', syncLogSchema);
