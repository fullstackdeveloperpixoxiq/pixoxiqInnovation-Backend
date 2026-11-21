import mongoose from 'mongoose';
import { toJSONPlugin } from './plugins.js';

// A newsletter email sent (or being sent) to all confirmed subscribers
const campaignSchema = new mongoose.Schema(
  {
    subject: { type: String, required: [true, 'Subject is required'], trim: true, maxlength: 160 },
    // Plain text body; paragraphs separated by blank lines. Rendered into a branded HTML email.
    content: { type: String, required: [true, 'Content is required'], trim: true, maxlength: 20000 },
    announcement: { type: mongoose.Schema.Types.ObjectId, ref: 'Announcement', default: null },
    status: { type: String, enum: ['sending', 'sent', 'failed'], default: 'sending' },
    recipients: { type: Number, default: 0 },
    delivered: { type: Number, default: 0 },
    failed: { type: Number, default: 0 },
    lastError: { type: String, default: '' },
    sentBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
    completedAt: Date,
  },
  { timestamps: true }
);

campaignSchema.plugin(toJSONPlugin);

export default mongoose.model('NewsletterCampaign', campaignSchema);
