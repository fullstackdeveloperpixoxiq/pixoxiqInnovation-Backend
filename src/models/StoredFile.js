import mongoose from 'mongoose';

// A small uploaded file kept in the database instead of on the server's disk, so it
// survives restarts and redeploys (the local uploads/ folder does not on hosts with an
// ephemeral filesystem). Served publicly, read-only, at /api/public/files/:id.
const storedFileSchema = new mongoose.Schema(
  {
    data: { type: Buffer, required: true },
    contentType: { type: String, required: true },
    size: { type: Number, required: true },
    // What the file is used for, e.g. "visiting-card/profile-photo"
    purpose: { type: String, default: '' },
  },
  { timestamps: true }
);

export default mongoose.model('StoredFile', storedFileSchema);
