import mongoose from 'mongoose';
import { toJSONPlugin } from './plugins.js';

export const APPLICATION_STATUSES = ['new', 'reviewing', 'shortlisted', 'interview', 'hired', 'rejected'];

const applicationSchema = new mongoose.Schema(
  {
    name: { type: String, required: [true, 'Name is required'], trim: true, maxlength: 100 },
    email: {
      type: String,
      required: [true, 'Email is required'],
      lowercase: true,
      trim: true,
      match: [/^\S+@\S+\.\S+$/, 'Enter a valid email'],
    },
    phone: { type: String, required: [true, 'Phone is required'], trim: true, maxlength: 25 },
    linkedin: { type: String, trim: true, maxlength: 300, default: '' },
    // Legacy: older applications shared a link to the resume
    resumeUrl: { type: String, trim: true, maxlength: 500, default: '' },
    // Uploaded resume (PDF, DOCX or image) kept in the database; served to admins only
    resumeFile: { type: mongoose.Schema.Types.ObjectId, ref: 'StoredFile', default: null },
    resumeName: { type: String, trim: true, maxlength: 200, default: '' },
    position: { type: String, required: [true, 'Position is required'], trim: true, maxlength: 120 },
    // Website account that submitted it (null for guests / older applications)
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    vacancy: { type: mongoose.Schema.Types.ObjectId, ref: 'Vacancy', default: null },
    experience: { type: String, trim: true, maxlength: 40, default: '' },
    message: { type: String, trim: true, maxlength: 5000, default: '' },
    status: { type: String, enum: APPLICATION_STATUSES, default: 'new' },
    notes: { type: String, trim: true, maxlength: 2000, default: '' },
    // Odoo sync: id of the record created in Odoo, null until pushed
    odooId: { type: Number, default: null, index: true },
    odooSyncedAt: Date,
    odooAttempts: { type: Number, default: 0 },
    odooError: { type: String, default: '' },
  },
  { timestamps: true }
);

applicationSchema.index({ status: 1, createdAt: -1 });

// Status shown to the applicant on the website: the same hiring stages the admin uses.
// A brand-new application is shown as "reviewing" (it is waiting in the review queue).
export const publicStatus = (status) => (status === 'new' ? 'reviewing' : status);

applicationSchema.plugin(toJSONPlugin);

export default mongoose.model('Application', applicationSchema);
