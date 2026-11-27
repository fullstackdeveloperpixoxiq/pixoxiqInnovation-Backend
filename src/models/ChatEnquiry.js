import mongoose from 'mongoose';
import { toJSONPlugin } from './plugins.js';

export const ENQUIRY_TYPES = ['job', 'website'];
export const ENQUIRY_STATUSES = ['new', 'in_progress', 'resolved'];
// Odoo Recruitment sync of job enquiries. not_submitted: the candidate has not submitted the
// application (with consent) yet, so nothing is sent to Odoo.
export const SYNC_STATUSES = ['not_submitted', 'pending', 'processing', 'synced', 'failed', 'requires_attention'];

const candidateSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true, maxlength: 100, default: '' },
    phone: { type: String, trim: true, maxlength: 25, default: '' },
    position: { type: String, trim: true, maxlength: 120, default: '' },
    message: { type: String, trim: true, maxlength: 3000, default: '' },
    skills: { type: String, trim: true, maxlength: 500, default: '' },
    experience: { type: String, trim: true, maxlength: 200, default: '' },
    qualification: { type: String, trim: true, maxlength: 200, default: '' },
    location: { type: String, trim: true, maxlength: 120, default: '' },
    linkedin: { type: String, trim: true, maxlength: 300, default: '' },
  },
  { _id: false }
);

const odooSyncSchema = new mongoose.Schema(
  {
    status: { type: String, enum: SYNC_STATUSES, default: 'not_submitted' },
    applicantId: { type: Number, default: null },
    attachmentId: { type: Number, default: null },
    jobId: { type: Number, default: null },
    attempts: { type: Number, default: 0 },
    lastAttemptAt: Date,
    lastError: { type: String, maxlength: 1000, default: '' },
    nextRetryAt: Date,
    syncedAt: Date,
    // Worker lease: a crashed worker's claim expires so the enquiry is picked up again
    leaseUntil: Date,
    // Details changed after the last successful sync: the applicant is updated on the next run
    needsUpdate: { type: Boolean, default: false },
    changedAt: Date,
  },
  { _id: false }
);

// An identifiable enquiry made through the AI assistant. Created only for logged-in users
// (job + website) and email-verified visitors (job); anonymous visitors never get one.
// One record per conversation and type (unique index), updated as the conversation goes on.
const chatEnquirySchema = new mongoose.Schema(
  {
    type: { type: String, enum: ENQUIRY_TYPES, required: true },
    conversation: { type: mongoose.Schema.Types.ObjectId, ref: 'ChatConversation', required: true },
    // registered: website account (user); email_verified: visitor who confirmed an email by OTP
    authType: { type: String, enum: ['registered', 'email_verified'], required: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    name: { type: String, trim: true, maxlength: 100, default: '' },
    email: { type: String, trim: true, lowercase: true, maxlength: 254, required: true },
    status: { type: String, enum: ENQUIRY_STATUSES, default: 'new' },
    // Latest classification
    category: { type: String, default: '' },
    confidence: { type: Number, min: 0, max: 1, default: 0 },
    questionCount: { type: Number, default: 0 },
    lastQuestion: { type: String, maxlength: 500, default: '' },
    // Open vacancy the visitor asked about, when the classifier matched one
    vacancy: { type: mongoose.Schema.Types.ObjectId, ref: 'Vacancy', default: null },
    vacancyTitle: { type: String, default: '' },
    // Part of the unique key: one job enquiry per conversation and vacancy ('' = general)
    vacancyKey: { type: String, default: '' },
    // Job enquiries: details collected in the conversation / confirmed by the candidate
    candidate: { type: candidateSchema, default: () => ({}) },
    resume: {
      file: { type: mongoose.Schema.Types.ObjectId, ref: 'StoredFile', default: null },
      name: { type: String, maxlength: 200, default: '' },
      size: Number,
      contentType: String,
      uploadedAt: Date,
    },
    // Candidate agreed to their details (and CV) being sent to PIXOXIQ's recruitment system
    consentAt: Date,
    submittedAt: Date,
    odoo: { type: odooSyncSchema, default: () => ({}) },
    firstAt: { type: Date, default: Date.now },
    lastAt: { type: Date, default: Date.now },
    statusUpdatedAt: Date,
    statusUpdatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
  },
  { timestamps: true }
);

chatEnquirySchema.index({ conversation: 1, type: 1, vacancyKey: 1 }, { unique: true });
chatEnquirySchema.index({ 'odoo.status': 1, 'odoo.nextRetryAt': 1 });
chatEnquirySchema.index({ vacancy: 1, type: 1 });
chatEnquirySchema.index({ type: 1, status: 1, lastAt: -1 });
chatEnquirySchema.index({ type: 1, firstAt: -1 });
chatEnquirySchema.index({ email: 1 });

chatEnquirySchema.plugin(toJSONPlugin);

export default mongoose.model('ChatEnquiry', chatEnquirySchema);
