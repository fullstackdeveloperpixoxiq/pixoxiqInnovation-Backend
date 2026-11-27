import ChatEnquiry from '../models/ChatEnquiry.js';
import ChatEnquirySyncLog from '../models/ChatEnquirySyncLog.js';
import StoredFile from '../models/StoredFile.js';
import Vacancy from '../models/Vacancy.js';
import { escapeHtml } from './emailService.js';
import { isRecruitmentSyncEnabled, odooCall, odooFields, odooRecruitmentSettings } from './odoo.js';
import { ensureOdooJob } from './odooSync.js';
import { logAi } from '../ai/logger.js';

// Chatbot job enquiries -> Odoo Recruitment (hr.applicant), Odoo 17-19.
//
// Only enquiries the candidate SUBMITTED (with consent) are sent; website enquiries never are.
// The enquiry is always saved in MongoDB first, then synced by a background worker:
//   pending -> processing -> synced | failed (automatic retry, exponential backoff)
//                                   | requires_attention (needs an admin: access rights,
//                                     invalid data, deleted applicant, too many failures)
// Duplicates are prevented by a stable reference (PIXOXIQ-ENQ-<id>) written in the
// applicant notes, an existing-applicant check (same email + job), and the applicant id saved
// right after creation. A worker lease makes sure one enquiry is processed by one worker.

const BASE_DELAY_MS = 30 * 1000;
const MAX_DELAY_MS = 6 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 8;
const LEASE_MS = 5 * 60 * 1000;
const TICK_MS = 30 * 1000;
const DISABLED_RECHECK_MS = 15 * 60 * 1000;

export const enquiryReference = (enquiry) => `PIXOXIQ-ENQ-${enquiry._id}`;
export const retryDelay = (attempts) => Math.min(BASE_DELAY_MS * 2 ** Math.max(0, attempts - 1), MAX_DELAY_MS);

const log = (...args) => console.log('[recruitment]', ...args);

/** After the candidate changed details of a submitted application: update Odoo on the next run */
export const markEnquiryChanged = (enquiry) => {
  if (!enquiry.submittedAt) return;
  enquiry.odoo.needsUpdate = true;
  enquiry.odoo.changedAt = new Date();
  if (['synced', 'failed', 'requires_attention'].includes(enquiry.odoo.status)) {
    enquiry.odoo.status = 'pending';
    enquiry.odoo.nextRetryAt = new Date();
    enquiry.odoo.attempts = 0;
  }
};

// ---------- Odoo mapping ----------

const AUTH_LABEL = { registered: 'Registered PIXOXIQ account', email_verified: 'Email-verified guest (no account)' };

const notesHtml = (enquiry, vacancyTitle) => {
  const c = enquiry.candidate || {};
  const rows = [
    ['Source', `PIXOXIQ AI Assistant – ${AUTH_LABEL[enquiry.authType] || enquiry.authType}`],
    ['Position', c.position || vacancyTitle || 'General application'],
    ['Enquiry', c.message],
    ['Skills', c.skills],
    ['Experience', c.experience],
    ['Qualification', c.qualification],
    ['Preferred location', c.location],
    ['LinkedIn / portfolio', c.linkedin],
    ['CV', enquiry.resume?.file ? `attached (${enquiry.resume.name || 'file'})` : 'not provided'],
    ['Consent', enquiry.consentAt ? `given on ${enquiry.consentAt.toISOString()}` : ''],
    ['Reference', enquiryReference(enquiry)],
  ].filter(([, v]) => v);
  return rows.map(([k, v]) => `<p><strong>${escapeHtml(k)}:</strong> ${escapeHtml(v).replace(/\n/g, '<br>')}</p>`).join('');
};

// utm.source "PIXOXIQ AI Assistant" (found, or created when the API user may create it)
let sourceCache = { name: '', id: null };
const sourceId = async (name) => {
  if (!name) return null;
  if (sourceCache.name === name && sourceCache.id) return sourceCache.id;
  try {
    const [found] = await odooCall('utm.source', 'search_read', { domain: [['name', '=', name]], fields: ['id'], limit: 1 });
    const id = found?.id || (await odooCall('utm.source', 'create', { vals_list: [{ name }] }))[0];
    sourceCache = { name, id };
    return id;
  } catch {
    return null; // optional: applicants are still created without a source
  }
};

class SyncError extends Error {
  constructor(message, { permanent = false } = {}) {
    super(message);
    this.permanent = permanent;
  }
}

const resolveJob = async (enquiry) => {
  if (enquiry.vacancy) {
    const vacancy = await Vacancy.findById(enquiry.vacancy);
    if (vacancy) return { jobId: await ensureOdooJob(vacancy, vacancy.title), title: vacancy.title };
  }
  // General career enquiry: the configured default job position, or none
  const { defaultJobId } = odooRecruitmentSettings();
  if (defaultJobId) {
    const exists = await odooCall('hr.job', 'search_count', { domain: [['id', '=', defaultJobId]], context: { active_test: false } });
    if (!exists) throw new SyncError(`The default job position (#${defaultJobId}) no longer exists in Odoo. Choose another one in Odoo Integration settings.`, { permanent: true });
    return { jobId: defaultJobId, title: '' };
  }
  return { jobId: null, title: '' };
};

const uploadResume = async (enquiry, applicantId) => {
  const file = await StoredFile.findById(enquiry.resume.file);
  if (!file?.data) return null;
  const [attachmentId] = await odooCall('ir.attachment', 'create', {
    vals_list: [
      {
        name: enquiry.resume.name || file.filename || 'cv',
        datas: Buffer.from(file.data).toString('base64'),
        mimetype: file.contentType,
        res_model: 'hr.applicant',
        res_id: applicantId,
      },
    ],
  });
  // Verify it is really attached to the applicant
  const ok = await odooCall('ir.attachment', 'search_count', {
    domain: [['id', '=', attachmentId], ['res_model', '=', 'hr.applicant'], ['res_id', '=', applicantId]],
  });
  if (!ok) throw new SyncError('The CV was uploaded but Odoo does not show it on the applicant');
  return attachmentId;
};

/** Creates, links or updates the Odoo applicant for an enquiry. */
export const pushEnquiryToOdoo = async (enquiry) => {
  const fields = await odooFields('hr.applicant');
  const notesField = fields.has('applicant_notes') ? 'applicant_notes' : fields.has('description') ? 'description' : null;
  const { jobId, title } = await resolveJob(enquiry);
  const c = enquiry.candidate || {};
  const reference = enquiryReference(enquiry);

  const vals = {};
  const set = (field, value) => {
    if (fields.has(field) && value !== undefined && value !== '') vals[field] = value;
  };
  set('partner_name', c.name || enquiry.name);
  set('email_from', enquiry.email);
  set('partner_phone', c.phone);
  set('linkedin_profile', c.linkedin);
  if (jobId) set('job_id', jobId);
  if (fields.has('name')) vals.name = `${c.position || title || 'General application'} – ${c.name || enquiry.email}`; // Odoo <= 17
  if (notesField) vals[notesField] = notesHtml(enquiry, title);
  if (fields.has('source_id')) {
    const src = await sourceId(odooRecruitmentSettings().sourceName);
    if (src) vals.source_id = src;
  }

  let applicantId = enquiry.odoo.applicantId;
  let outcome;

  if (applicantId) {
    const exists = await odooCall('hr.applicant', 'search_count', { domain: [['id', '=', applicantId]], context: { active_test: false } });
    if (!exists) {
      throw new SyncError(`Odoo applicant #${applicantId} was deleted in Odoo. Clear it in Odoo or contact support before syncing again.`, { permanent: true });
    }
    await odooCall('hr.applicant', 'write', { ids: [applicantId], vals });
    outcome = 'updated';
  } else {
    // 1. Already created for this enquiry (e.g. the worker stopped before saving the id)
    let match = notesField
      ? (await odooCall('hr.applicant', 'search_read', { domain: [[notesField, 'ilike', reference]], fields: ['id'], limit: 1, context: { active_test: false } }))[0]
      : null;
    if (match) {
      applicantId = match.id;
      await odooCall('hr.applicant', 'write', { ids: [applicantId], vals });
      outcome = 'linked';
    } else if (fields.has('email_from')) {
      // 2. The candidate already has an open application for the same job (e.g. from the
      //    website form): link to it instead of creating a duplicate, and add a note
      [match] = await odooCall('hr.applicant', 'search_read', {
        domain: [['email_from', '=ilike', enquiry.email], ['job_id', '=', jobId || false]],
        fields: ['id'],
        limit: 1,
      });
      if (match) {
        applicantId = match.id;
        await odooCall('hr.applicant', 'message_post', { ids: [applicantId], body: notesHtml(enquiry, title), message_type: 'comment', subtype_xmlid: 'mail.mt_note' }).catch(() => {});
        outcome = 'linked';
      }
    }
    if (!applicantId) {
      [applicantId] = await odooCall('hr.applicant', 'create', { vals_list: [vals] });
      outcome = 'created';
    }
    // Saved immediately: a failure later (CV upload) must never lead to a second applicant
    await ChatEnquiry.updateOne({ _id: enquiry._id }, { $set: { 'odoo.applicantId': applicantId, 'odoo.jobId': jobId } });
    enquiry.odoo.applicantId = applicantId;
  }

  // CV: uploaded once, and again only when the candidate replaced it
  let attachmentId = enquiry.odoo.attachmentId;
  const resumeIsNew = enquiry.resume?.file && (!attachmentId || (enquiry.odoo.syncedAt && enquiry.resume.uploadedAt > enquiry.odoo.syncedAt));
  if (resumeIsNew) attachmentId = await uploadResume(enquiry, applicantId);

  return { outcome, applicantId, attachmentId, jobId };
};

// ---------- Worker ----------

const claimFilter = (now) => ({
  type: 'job',
  submittedAt: { $ne: null },
  $or: [
    { 'odoo.status': { $in: ['pending', 'failed'] }, 'odoo.nextRetryAt': { $lte: now } },
    { 'odoo.status': 'processing', 'odoo.leaseUntil': { $lt: now } }, // abandoned by a crashed worker
  ],
});

const claim = (id) => {
  const now = new Date();
  return ChatEnquiry.findOneAndUpdate(
    { ...claimFilter(now), ...(id && { _id: id }) },
    { $set: { 'odoo.status': 'processing', 'odoo.leaseUntil': new Date(now.getTime() + LEASE_MS) } },
    { new: true, sort: { 'odoo.nextRetryAt': 1 } }
  );
};

const isPermanent = (err) => err.permanent || err.code === 'not_configured' || [400, 401, 403, 422].includes(err.status);

/** Processes one claimed enquiry. Never throws. */
const processClaimed = async (enquiry, { trigger = 'auto', admin = null } = {}) => {
  const started = Date.now();
  if (!isRecruitmentSyncEnabled()) {
    await ChatEnquiry.updateOne(
      { _id: enquiry._id },
      {
        $set: {
          'odoo.status': 'pending',
          'odoo.leaseUntil': null,
          'odoo.lastError': 'Odoo Recruitment integration is disabled or not configured. The enquiry is kept and will be sent once it is enabled.',
          'odoo.nextRetryAt': new Date(Date.now() + DISABLED_RECHECK_MS),
        },
      }
    );
    return { status: 'pending', error: 'Odoo Recruitment integration is disabled or not configured.' };
  }

  const attempts = (enquiry.odoo.attempts || 0) + 1;
  const now = new Date();
  try {
    const result = await pushEnquiryToOdoo(enquiry);
    // Details changed while this run was in progress: run once more
    const claimedAt = new Date((enquiry.odoo.leaseUntil?.getTime() || Date.now()) - LEASE_MS);
    const changedMeanwhile = await ChatEnquiry.exists({ _id: enquiry._id, 'odoo.changedAt': { $gt: claimedAt } });
    await ChatEnquiry.updateOne(
      { _id: enquiry._id },
      {
        $set: {
          'odoo.status': changedMeanwhile ? 'pending' : 'synced',
          'odoo.applicantId': result.applicantId,
          'odoo.attachmentId': result.attachmentId ?? null,
          'odoo.jobId': result.jobId,
          'odoo.attempts': 0,
          'odoo.lastAttemptAt': now,
          'odoo.lastError': '',
          'odoo.nextRetryAt': changedMeanwhile ? new Date() : null,
          'odoo.syncedAt': now,
          'odoo.leaseUntil': null,
          'odoo.needsUpdate': Boolean(changedMeanwhile),
        },
      }
    );
    await ChatEnquirySyncLog.create({
      enquiry: enquiry._id,
      attempt: attempts,
      outcome: result.outcome,
      trigger,
      admin,
      applicantId: result.applicantId,
      attachmentId: result.attachmentId ?? null,
      durationMs: Date.now() - started,
    });
    log(`enquiry ${enquiry.id} -> Odoo applicant #${result.applicantId} (${result.outcome})`);
    return { status: 'synced', applicantId: result.applicantId, outcome: result.outcome };
  } catch (err) {
    const permanent = isPermanent(err) || attempts >= MAX_ATTEMPTS;
    const status = permanent ? 'requires_attention' : 'failed';
    const nextRetryAt = permanent ? null : new Date(Date.now() + retryDelay(attempts));
    const error = String(err.message || 'Unknown error').slice(0, 1000);
    await ChatEnquiry.updateOne(
      { _id: enquiry._id },
      {
        $set: {
          'odoo.status': status,
          'odoo.attempts': attempts,
          'odoo.lastAttemptAt': now,
          'odoo.lastError': error,
          'odoo.nextRetryAt': nextRetryAt,
          'odoo.leaseUntil': null,
        },
      }
    );
    await ChatEnquirySyncLog.create({
      enquiry: enquiry._id,
      attempt: attempts,
      outcome: status,
      trigger,
      admin,
      applicantId: enquiry.odoo.applicantId || null,
      error,
      nextRetryAt,
      durationMs: Date.now() - started,
    });
    if (permanent) {
      await logAi({ source: 'recruitment', message: `Job enquiry ${enquiry.id} needs attention: ${error}`, context: { enquiryId: enquiry.id, attempts } });
    }
    console.error(`[recruitment] enquiry ${enquiry.id} attempt ${attempts} failed (${status}):`, error);
    return { status, error, nextRetryAt };
  }
};

/** Background run: processes due enquiries (a few per tick). */
export const runRecruitmentSyncOnce = async (max = 10) => {
  let processed = 0;
  while (processed < max) {
    // eslint-disable-next-line no-await-in-loop
    const enquiry = await claim();
    if (!enquiry) break;
    // eslint-disable-next-line no-await-in-loop
    await processClaimed(enquiry, { trigger: enquiry.odoo.needsUpdate && enquiry.odoo.applicantId ? 'update' : 'auto' });
    processed += 1;
  }
  return processed;
};

/** Right after a submission: try now, in the background (the candidate never waits for Odoo) */
export const queueEnquirySync = (enquiryId) => {
  setImmediate(async () => {
    const enquiry = await claim(enquiryId).catch(() => null);
    if (enquiry) await processClaimed(enquiry, { trigger: 'submit' });
  });
};

/**
 * Admin "Sync now" / "Retry": runs the sync for one enquiry immediately.
 * @returns result of the attempt, or { busy: true } if another worker holds it
 */
export const syncEnquiryNow = async (enquiryId, adminId) => {
  const queued = await ChatEnquiry.findOneAndUpdate(
    {
      _id: enquiryId,
      type: 'job',
      submittedAt: { $ne: null },
      $or: [{ 'odoo.status': { $ne: 'processing' } }, { 'odoo.leaseUntil': { $lt: new Date() } }],
    },
    { $set: { 'odoo.status': 'pending', 'odoo.nextRetryAt': new Date(0) } },
    { new: true }
  );
  if (!queued) return { busy: true };
  const enquiry = await claim(enquiryId);
  if (!enquiry) return { busy: true };
  return processClaimed(enquiry, { trigger: 'manual', admin: adminId });
};

let timer = null;
export const startRecruitmentSync = () => {
  if (timer) return;
  const tick = () => {
    if (!isRecruitmentSyncEnabled()) return;
    runRecruitmentSyncOnce().catch((err) => console.error('[recruitment] sync run failed:', err.message));
  };
  timer = setInterval(tick, TICK_MS);
  timer.unref();
  setTimeout(tick, 15 * 1000).unref();
};
