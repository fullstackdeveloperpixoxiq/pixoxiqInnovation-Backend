import ChatConversation from '../models/ChatConversation.js';
import ChatMessage from '../models/ChatMessage.js';
import { getChatSettings } from './chatService.js';
import { recoverIndexing } from './indexer.js';

// Background jobs of the AI assistant: resume interrupted indexing on startup and delete
// conversations older than the retention period set in the admin panel.

const SIX_HOURS = 6 * 60 * 60 * 1000;

export const purgeOldConversations = async () => {
  const { retentionDays } = await getChatSettings();
  if (!retentionDays) return 0;
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const ids = await ChatConversation.find({ lastMessageAt: { $lt: cutoff } }).distinct('_id');
  if (!ids.length) return 0;
  await ChatMessage.deleteMany({ conversation: { $in: ids } });
  await ChatConversation.deleteMany({ _id: { $in: ids } });
  console.log(`[ai] deleted ${ids.length} conversation(s) older than ${retentionDays} days`);
  return ids.length;
};

export const startAiBackgroundJobs = () => {
  recoverIndexing().catch((err) => console.error('[ai] could not resume indexing:', err.message));
  const run = () => purgeOldConversations().catch((err) => console.error('[ai] retention cleanup failed:', err.message));
  setTimeout(run, 60 * 1000).unref();
  setInterval(run, SIX_HOURS).unref();
};
