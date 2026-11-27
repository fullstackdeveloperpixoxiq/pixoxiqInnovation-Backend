import mongoose from 'mongoose';

// Odoo connection and Recruitment integration settings (single document), managed by
// superadmins in the admin panel. The API key is stored AES-256-GCM encrypted (ai/crypto.js,
// AI_ENCRYPTION_KEY) and never returned by the API. When no key is saved here, the ODOO_*
// environment variables are used, so existing deployments keep working unchanged.
const odooConfigSchema = new mongoose.Schema(
  {
    key: { type: String, default: 'default', unique: true },
    url: { type: String, trim: true, maxlength: 300, default: '' },
    db: { type: String, trim: true, maxlength: 120, default: '' },
    // Login email of the API user: only needed for Odoo versions without the JSON-2 API (< 19)
    username: { type: String, trim: true, maxlength: 200, default: '' },
    apiKeyEnc: { type: String, default: '', select: false },
    apiKeyLast4: { type: String, default: '' },
    // Chatbot job enquiries -> Odoo Recruitment applicants
    recruitmentEnabled: { type: Boolean, default: false },
    // Odoo job position (hr.job id) for career enquiries without a specific vacancy.
    // null = create the applicant without a job position (Odoo's general applications).
    defaultJobId: { type: Number, default: null },
    defaultJobName: { type: String, default: '' },
    // utm.source name set on applicants from the assistant (found or created in Odoo)
    sourceName: { type: String, trim: true, maxlength: 100, default: 'PIXOXIQ AI Assistant' },
    // Last connection test
    version: { type: String, default: '' },
    apiMode: { type: String, default: '' },
    lastTest: {
      ok: Boolean,
      at: Date,
      message: { type: String, maxlength: 1000 },
    },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
  },
  { timestamps: true }
);

odooConfigSchema.statics.getSingleton = async function getSingleton({ withSecrets = false } = {}) {
  const query = this.findOne({ key: 'default' });
  if (withSecrets) query.select('+apiKeyEnc');
  const doc = await query;
  if (doc) return doc;
  try {
    await this.create({ key: 'default' });
  } catch (err) {
    if (err.code !== 11000) throw err;
  }
  const again = this.findOne({ key: 'default' });
  if (withSecrets) again.select('+apiKeyEnc');
  return again;
};

export default mongoose.model('OdooConfig', odooConfigSchema);
