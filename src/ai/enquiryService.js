import ChatEnquiry from '../models/ChatEnquiry.js';
import ChatEnquirySyncLog from '../models/ChatEnquirySyncLog.js';
import StoredFile from '../models/StoredFile.js';
import { INTENTS } from './intentService.js';

// Identifiable job enquiry records for the admin panel (AI Chatbot -> Job Queries).
// Logged-in users and email-verified visitors only; anonymous visitors never get one.
// One per conversation and vacancy (a general career enquiry upgrades to a vacancy once one is
// identified), so repeated messages update the same record, while a different position is a
// separate one. General conversations need no record: they are listed from the conversations
// themselves (AI Chatbot -> Normal / General Queries).

const typeOf = (category) => (category === INTENTS.JOB ? 'job' : category === INTENTS.WEBSITE ? 'website' : null);

// Earlier versions had a unique (conversation, type) index; it would block a second vacancy
let indexesChecked = null;
const ensureIndexes = () => {
  if (!indexesChecked) {
    indexesChecked = (async () => {
      const existing = await ChatEnquiry.collection.indexes().catch(() => []);
      if (existing.some((i) => i.name === 'conversation_1_type_1')) {
        await ChatEnquiry.collection.dropIndex('conversation_1_type_1').catch(() => {});
      }
      await ChatEnquiry.init();
    })().catch((err) => {
      indexesChecked = null;
      throw err;
    });
  }
  return indexesChecked;
};

export const recordEnquiry = async ({ conversation, intent, access, question }) => {
  const type = typeOf(intent.category);
  // General questions are managed on the conversation itself (Normal / General Queries), so no
  // separate record is created for them
  if (type !== 'job' || !access) return null;
  await ensureIndexes();

  const now = new Date();
  const set = {
    authType: access.method === 'account' ? 'registered' : 'email_verified',
    user: access.method === 'account' ? access.user : null,
    email: access.email,
    category: intent.category,
    confidence: intent.confidence,
    lastQuestion: String(question || '').slice(0, 500),
    lastAt: now,
  };
  if (access.name) set.name = access.name;
  const vacancyKey = type === 'job' && intent.vacancy ? String(intent.vacancy.id) : '';
  if (vacancyKey) {
    set.vacancy = intent.vacancy.id;
    set.vacancyTitle = intent.vacancy.title;
  }
  const base = { conversation: conversation._id, type };
  const update = (extra = {}) => ({ $set: { ...set, ...extra }, $inc: { questionCount: 1 } });
  const onInsert = {
    firstAt: now,
    status: 'new',
    ...(type === 'job' && {
      // Registered users: details already in their account are not asked again
      candidate: {
        name: access.name || '',
        phone: access.phone || '',
        position: intent.vacancy?.title || '',
      },
    }),
  };

  if (type === 'job') {
    // Same vacancy (or general): update that record
    const same = await ChatEnquiry.findOneAndUpdate({ ...base, vacancyKey }, update(), { new: true });
    if (same) return same;
    // A follow-up that names no vacancy ("what is the salary?") continues the conversation's
    // latest job enquiry instead of starting a general one
    if (!vacancyKey) {
      const latest = await ChatEnquiry.findOneAndUpdate(base, update(), { new: true, sort: { lastAt: -1 } });
      if (latest) return latest;
    }
    // A vacancy was identified in a conversation that so far had a general enquiry that has
    // not been submitted yet: it becomes the enquiry for that vacancy
    if (vacancyKey) {
      try {
        const upgraded = await ChatEnquiry.findOneAndUpdate(
          { ...base, vacancyKey: '', submittedAt: null },
          update({ vacancyKey, 'candidate.position': intent.vacancy.title }),
          { new: true }
        );
        if (upgraded) return upgraded;
      } catch (err) {
        if (err.code !== 11000) throw err;
      }
    }
  }

  const filter = { ...base, vacancyKey };
  try {
    return await ChatEnquiry.findOneAndUpdate(filter, { ...update({ vacancyKey }), $setOnInsert: onInsert }, { upsert: true, new: true });
  } catch (err) {
    // Two requests created it at the same moment: update the one that won
    if (err.code !== 11000) throw err;
    return ChatEnquiry.findOneAndUpdate(filter, update(), { new: true });
  }
};

/** Deletes enquiries of conversations, with their sync logs and uploaded CVs */
export const deleteEnquiriesFor = async (conversationIds) => {
  const filter = { conversation: { $in: [].concat(conversationIds) } };
  const enquiries = await ChatEnquiry.find(filter).select('_id resume.file').lean();
  if (!enquiries.length) return;
  const files = enquiries.map((e) => e.resume?.file).filter(Boolean);
  await Promise.all([
    ChatEnquirySyncLog.deleteMany({ enquiry: { $in: enquiries.map((e) => e._id) } }),
    files.length ? StoredFile.deleteMany({ _id: { $in: files } }) : null,
  ]);
  await ChatEnquiry.deleteMany(filter);
};
