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
    resumeUrl: { type: String, required: [true, 'Resume link is required'], trim: true, maxlength: 500 },
    position: { type: String, required: [true, 'Position is required'], trim: true, maxlength: 120 },
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

applicationSchema.plugin(toJSONPlugin);

export default mongoose.model('Application', applicationSchema);
