import mongoose from 'mongoose';
import { toJSONPlugin } from './plugins.js';

export const JOB_TYPES = ['Full-time', 'Part-time', 'Contract', 'Internship'];
export const WORK_MODES = ['On-site', 'Hybrid', 'Remote'];

const vacancySchema = new mongoose.Schema(
  {
    title: { type: String, required: [true, 'Job title is required'], trim: true, maxlength: 120 },
    department: { type: String, required: [true, 'Department is required'], trim: true, maxlength: 60 },
    location: { type: String, default: 'Kerala, India', trim: true, maxlength: 100 },
    type: { type: String, enum: JOB_TYPES, default: 'Full-time' },
    mode: { type: String, enum: WORK_MODES, default: 'On-site' },
    experience: { type: String, trim: true, maxlength: 40, default: '' },
    salary: { type: String, trim: true, maxlength: 60, default: '' },
    description: { type: String, required: [true, 'Description is required'], trim: true, maxlength: 3000 },
    requirements: {
      type: [{ type: String, trim: true, maxlength: 300 }],
      default: [],
    },
    deadline: Date,
    isActive: { type: Boolean, default: true },
    // 'odoo' = copied from Odoo Recruitment and updated by the sync; 'admin' = created here
    source: { type: String, enum: ['admin', 'odoo'], default: 'admin' },
    odooId: { type: Number, default: null, index: true },
    odooSyncedAt: Date,
    order: { type: Number, default: 0 },
  },
  { timestamps: true }
);

vacancySchema.index({ isActive: 1, order: 1 });

vacancySchema.pre('validate', function cleanRequirements(next) {
  this.requirements = (this.requirements || []).filter(Boolean);
  next();
});

vacancySchema.plugin(toJSONPlugin);

export default mongoose.model('Vacancy', vacancySchema);
