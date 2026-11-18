import KnowledgeEntry from '../models/KnowledgeEntry.js';
import KnowledgeChunk from '../models/KnowledgeChunk.js';
import { chunkText } from './chunker.js';
import { getEmbeddingClient } from './configService.js';
import { markKnowledgeChanged } from './retrieval.js';
import { logAi } from './logger.js';
import { redact } from './redact.js';

// Background indexing queue: chunk -> embed -> store, one entry at a time.
// Entries waiting here have status "pending"; on startup unfinished ones are re-queued.

const queue = [];
const queued = new Set();
let running = false;

const indexEntry = async (id) => {
  const entry = await KnowledgeEntry.findById(id).select('+content');
  if (!entry) return;
  const { contentHash } = entry;

  entry.status = 'processing';
  entry.error = '';
  await entry.save();

  let client = null;
  try {
    const pieces = chunkText(entry.content);
    client = await getEmbeddingClient();

    let vectors = null;
    if (client && pieces.length) {
      const inputs = pieces.map((p) => `${entry.title}\n${entry.category}\n\n${p}`);
      ({ vectors } = await client.embed(inputs, { taskType: 'document' }));
    }

    // The entry was edited while we were working: a newer job will index it
    const current = await KnowledgeEntry.findById(id).select('contentHash title category');
    if (!current || current.contentHash !== contentHash) return;

    await KnowledgeChunk.deleteMany({ entry: id });
    if (pieces.length) {
      await KnowledgeChunk.insertMany(
        pieces.map((text, i) => ({
          entry: id,
          index: i,
          title: current.title,
          category: current.category,
          text,
          embedding: vectors ? vectors[i] : undefined,
          embeddingKey: vectors ? client.key : '',
        }))
      );
    }

    await KnowledgeEntry.updateOne(
      { _id: id, contentHash },
      {
        $set: {
          status: 'indexed',
          error: '',
          chunkCount: pieces.length,
          embeddingKey: vectors ? client.key : '',
          indexedAt: new Date(),
        },
      }
    );
  } catch (err) {
    const message = redact(err.message || 'Indexing failed', client?.secrets);
    await KnowledgeEntry.updateOne({ _id: id }, { $set: { status: 'failed', error: message.slice(0, 1000) } });
    await logAi({
      source: err.name === 'ProviderError' ? 'embedding' : 'indexing',
      message: `Indexing "${entry.title}" failed: ${message}`,
      code: err.code,
      provider: client?.provider,
      model: client?.model,
      providerStatus: err.providerStatus,
      context: { entryId: String(id) },
      secrets: client?.secrets,
    });
  } finally {
    markKnowledgeChanged();
  }
};

const run = async () => {
  if (running) return;
  running = true;
  try {
    while (queue.length) {
      const id = queue.shift();
      queued.delete(id);
      try {
        await indexEntry(id);
      } catch (err) {
        console.error('[ai:indexing] unexpected error', err);
      }
    }
  } finally {
    running = false;
  }
};

export const enqueueIndexing = (id) => {
  const key = String(id);
  if (!queued.has(key)) {
    queued.add(key);
    queue.push(key);
  }
  setImmediate(run);
};

export const queueLength = () => queue.length + (running ? 1 : 0);

// Re-queues entries left unfinished by a restart
export const recoverIndexing = async () => {
  const pending = await KnowledgeEntry.find({ status: { $in: ['pending', 'processing'] } }).distinct('_id');
  pending.forEach(enqueueIndexing);
  if (pending.length) console.log(`[ai:indexing] re-queued ${pending.length} knowledge entr${pending.length === 1 ? 'y' : 'ies'}`);
};

// Re-embeds the whole knowledge base (needed after changing the embedding model)
export const reindexAll = async () => {
  const ids = await KnowledgeEntry.find({}).distinct('_id');
  await KnowledgeEntry.updateMany({}, { $set: { status: 'pending', error: '' } });
  ids.forEach(enqueueIndexing);
  markKnowledgeChanged();
  return ids.length;
};
