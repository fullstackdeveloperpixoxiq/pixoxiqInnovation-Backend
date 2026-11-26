import mongoose from 'mongoose';
import { toJSONPlugin } from './plugins.js';

export const MESSAGE_STATUSES = ['new', 'read', 'replied', 'archived'];

const messageSchema = new mongoose.Schema(
  {
    name: { type: String, required: [true, 'Name is required'], trim: true, maxlength: 100 },
    email: {
      type: String,
      required: [true, 'Email is required'],
      lowercase: true,
      trim: true,
      match: [/^\S+@\S+\.\S+$/, 'Enter a valid email'],
    },
    whatsapp: {
      type: String,
      trim: true,
      maxlength: 25,
      default: '',
      match: [/^$|^\+?[0-9\s-]{7,20}$/, 'Enter a valid WhatsApp number'],
    },
    company: { type: String, trim: true, maxlength: 120, default: '' },
    message: { type: String, required: [true, 'Message is required'], trim: true, maxlength: 5000 },
    status: { type: String, enum: MESSAGE_STATUSES, default: 'new' },
    // Optional files from the visitor (ideas, product photos, specs): PDF or images kept in the
    // database and served to admins only
    attachments: {
      type: [
        {
          _id: false,
          file: { type: mongoose.Schema.Types.ObjectId, ref: 'StoredFile', required: true },
          name: { type: String, trim: true, maxlength: 200, default: '' },
          contentType: { type: String, default: '' },
          size: { type: Number, default: 0 },
        },
      ],
      default: [],
    },
    notes: { type: String, trim: true, maxlength: 2000, default: '' },
    readAt: Date,
    // Odoo sync: id of the record created in Odoo, null until pushed
    odooId: { type: Number, default: null, index: true },
    odooSyncedAt: Date,
    odooAttempts: { type: Number, default: 0 },
    odooError: { type: String, default: '' },
    ip: { type: String, select: false },
    userAgent: { type: String, select: false },
  },
  { timestamps: true }
);

messageSchema.index({ status: 1, createdAt: -1 });

messageSchema.plugin(toJSONPlugin);

export default mongoose.model('Message', messageSchema);
