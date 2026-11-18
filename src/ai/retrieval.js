import KnowledgeEntry from '../models/KnowledgeEntry.js';
import KnowledgeChunk from '../models/KnowledgeChunk.js';

// Hybrid retrieval over the knowledge base:
//  - vector similarity (cosine) when an embedding model is configured, combined with
//  - BM25 keyword scoring.
// The chunk index is held in memory and rebuilt whenever the knowledge base changes. This is
// fast up to tens of thousands of chunks, which is plenty for a company knowledge base; for
// much larger corpora, move to MongoDB Atlas Vector Search behind the same search() function.

const STOPWORDS = new Set(
  'a an and are as at be but by can do does for from has have how i in is it its me my of on or our please so that the their them there these they this to us was we what when where which who why will with you your about tell know any some more'.split(
    ' '
  )
);

export const tokenize = (text) =>
  (String(text).toLowerCase().match(/[\p{L}\p{N}]+/gu) || [])
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
    .map((t) => (t.length > 4 && t.endsWith('s') && !t.endsWith('ss') ? t.slice(0, -1) : t));

let version = 1;
let index = { version: 0, chunks: [], df: new Map(), avgLen: 1 };
let building = null;

// Call after any change to entries or chunks
export const markKnowledgeChanged = () => {
  version += 1;
};

const buildIndex = async () => {
  const target = version;
  // Chunks of entries being re-indexed stay searchable until they are replaced. Chunks of
  // edited content are deleted as soon as the edit is saved (knowledgeController).
  const active = await KnowledgeEntry.find({ isActive: true }).select('sourceType').lean();
  const sourceTypeOf = new Map(active.map((e) => [String(e._id), e.sourceType]));
  const rows = await KnowledgeChunk.find({ entry: { $in: active.map((e) => e._id) } })
    .select('entry title category text embedding embeddingKey')
    .lean();

  const df = new Map();
  let totalLen = 0;
  const chunks = rows.map((r) => {
    const terms = tokenize(`${r.title} ${r.category} ${r.text}`);
    const tf = new Map();
    terms.forEach((t) => tf.set(t, (tf.get(t) || 0) + 1));
    tf.forEach((_, t) => df.set(t, (df.get(t) || 0) + 1));
    totalLen += terms.length;
    return {
      id: String(r._id),
      entry: String(r.entry),
      sourceType: sourceTypeOf.get(String(r.entry)) || 'manual',
      title: r.title,
      category: r.category,
      text: r.text,
      vector: r.embedding?.length ? Float32Array.from(r.embedding) : null,
      embeddingKey: r.embeddingKey || '',
      tf,
      len: terms.length,
    };
  });
  index = { version: target, chunks, df, avgLen: chunks.length ? totalLen / chunks.length : 1 };
  return index;
};

const getIndex = async () => {
  if (index.version === version) return index;
  if (!building) {
    building = buildIndex().finally(() => {
      building = null;
    });
  }
  return building;
};

const bm25 = (chunk, qTerms, idx) => {
  const k1 = 1.2;
  const b = 0.75;
  const n = idx.chunks.length;
  let score = 0;
  let matched = 0;
  qTerms.forEach((t) => {
    const f = chunk.tf.get(t);
    if (!f) return;
    matched += 1;
    const df = idx.df.get(t) || 0;
    const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
    score += (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * chunk.len) / idx.avgLen));
  });
  return { score, matched };
};

const dot = (a, b) => {
  let s = 0;
  for (let i = 0; i < a.length; i += 1) s += a[i] * b[i];
  return s;
};

/**
 * Finds the knowledge chunks most relevant to `query`.
 * @param {string} query
 * @param {object} opts
 * @param {number} opts.topK
 * @param {number} opts.minRelevance   0..1
 * @param {object|null} opts.embeddingClient  from configService.getEmbeddingClient()
 * @returns {Promise<{ mode: 'hybrid'|'keyword', results: Array }>}
 */
export const searchKnowledge = async (query, { topK = 6, minRelevance = 0.2, embeddingClient = null, signal, excludeSourceTypes = [] } = {}) => {
  const full = await getIndex();
  const idx = excludeSourceTypes.length ? { ...full, chunks: full.chunks.filter((c) => !excludeSourceTypes.includes(c.sourceType)) } : full;
  const mode = embeddingClient ? 'hybrid' : 'keyword';
  if (!idx.chunks.length || !String(query).trim()) return { mode, results: [] };

  const qTerms = [...new Set(tokenize(query))];
  let qVec = null;
  if (embeddingClient) {
    // Errors propagate: a failing embedding model is reported, not silently skipped
    const { vectors } = await embeddingClient.embed([query], { taskType: 'query', signal });
    qVec = Float32Array.from(vectors[0]);
  }

  const keyword = idx.chunks.map((c) => bm25(c, qTerms, idx));
  const maxBm25 = Math.max(0, ...keyword.map((k) => k.score)) || 1;

  const scored = idx.chunks.map((chunk, i) => {
    const kw = keyword[i];
    const kwNorm = kw.score / maxBm25;
    const coverage = qTerms.length ? kw.matched / qTerms.length : 0;
    let score;
    if (qVec) {
      const comparable = chunk.vector && chunk.embeddingKey === embeddingClient.key && chunk.vector.length === qVec.length;
      const cos = comparable ? dot(chunk.vector, qVec) : 0;
      score = 0.8 * Math.max(cos, 0) + 0.2 * kwNorm;
    } else {
      score = kw.matched ? 0.5 * kwNorm + 0.5 * coverage : 0;
    }
    return { chunk, score };
  });

  const results = scored
    .filter((s) => s.score >= minRelevance)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map(({ chunk, score }) => ({
      chunkId: chunk.id,
      entryId: chunk.entry,
      title: chunk.title,
      category: chunk.category,
      text: chunk.text,
      score: Math.round(score * 1000) / 1000,
    }));

  return { mode, results };
};

export const indexStats = async () => {
  const idx = await getIndex();
  const byKey = {};
  idx.chunks.forEach((c) => {
    const k = c.vector ? c.embeddingKey : '(keyword only)';
    byKey[k] = (byKey[k] || 0) + 1;
  });
  return { chunks: idx.chunks.length, byEmbedding: byKey };
};
