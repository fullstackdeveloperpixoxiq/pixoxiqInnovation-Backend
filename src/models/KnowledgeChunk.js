import mongoose from 'mongoose';

// A retrievable piece of a KnowledgeEntry. `embedding` is empty when no embedding model
// is configured (keyword retrieval only).
const knowledgeChunkSchema = new mongoose.Schema(
  {
    entry: { type: mongoose.Schema.Types.ObjectId, ref: 'KnowledgeEntry', required: true, index: true },
    index: { type: Number, required: true },
    title: { type: String, default: '' },
    category: { type: String, default: '' },
    text: { type: String, required: true },
    embedding: { type: [Number], default: undefined },
    embeddingKey: { type: String, default: '' },
  },
  { timestamps: true }
);

export default mongoose.model('KnowledgeChunk', knowledgeChunkSchema);
