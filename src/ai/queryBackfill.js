import ChatConversation from '../models/ChatConversation.js';
import ChatMessage from '../models/ChatMessage.js';
import ChatEnquiry from '../models/ChatEnquiry.js';

// One-off, idempotent: conversations created before the Job / General split get their admin
// section from their existing records. Nothing is deleted or duplicated.
//  - job: has a job enquiry, or any question classified as JOB_ENQUIRY
//  - general: everything else (also the default for documents without the field)
export const backfillQueryTypes = async () => {
  const [enquiryConvs, jobMessageConvs] = await Promise.all([
    ChatEnquiry.distinct('conversation', { type: 'job' }),
    ChatMessage.distinct('conversation', { role: 'user', intent: 'JOB_ENQUIRY' }),
  ]);
  const jobIds = [...new Set([...enquiryConvs, ...jobMessageConvs].map(String))];
  const [job, general] = await Promise.all([
    jobIds.length ? ChatConversation.updateMany({ _id: { $in: jobIds }, queryType: { $ne: 'job' } }, { $set: { queryType: 'job' } }) : { modifiedCount: 0 },
    ChatConversation.updateMany({ queryType: { $exists: false }, _id: { $nin: jobIds } }, { $set: { queryType: 'general', adminStatus: 'open' } }),
  ]);
  if (job.modifiedCount || general.modifiedCount) {
    console.log(`[ai] classified existing conversations: ${job.modifiedCount} job, ${general.modifiedCount} general`);
  }
  return { job: job.modifiedCount, general: general.modifiedCount };
};
