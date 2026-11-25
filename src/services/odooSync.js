import Vacancy from '../models/Vacancy.js';
import Message from '../models/Message.js';
import Application from '../models/Application.js';
import StoredFile from '../models/StoredFile.js';
import env from '../config/env.js';
import { isOdooEnabled, odooCall, odooFields } from './odoo.js';
import { pullStatuses } from './odooStatus.js';

// Website <-> Odoo sync:
//  - Vacancies: published jobs in Odoo Recruitment (hr.job) are copied into the website's vacancies
//  - Contact messages: pushed to Odoo CRM as leads (crm.lead)
//  - Job applications: pushed to Odoo Recruitment as applicants (hr.applicant)
// Everything is still saved in MongoDB first, so the admin panel keeps working if Odoo is down.

const MAX_ATTEMPTS = 10;
const log = (...args) => console.log('[odoo]', ...args);

const htmlToText = (html) =>
  String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h\d)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

const many2oneName = (value) => (Array.isArray(value) ? value[1] : '');

// ---------- Vacancies (Odoo -> website) ----------

export const syncVacancies = async () => {
  const fields = await odooFields('hr.job');
  const publishedField = fields.has('is_published') ? 'is_published' : fields.has('website_published') ? 'website_published' : null;
  const wanted = ['name', 'department_id', 'address_id', 'description', 'no_of_recruitment'].filter((f) => fields.has(f));

  const jobs = await odooCall('hr.job', 'search_read', {
    domain: publishedField ? [[publishedField, '=', true], ['active', '=', true]] : [['active', '=', true]],
    fields: wanted,
  });

  const seen = [];
  for (const job of jobs) {
    seen.push(job.id);
    const description = htmlToText(job.description).slice(0, 3000) || job.name;
    await Vacancy.findOneAndUpdate(
      { odooId: job.id },
      {
        $set: {
          title: String(job.name).slice(0, 120),
          department: (many2oneName(job.department_id) || 'General').slice(0, 60),
          ...(many2oneName(job.address_id) && { location: many2oneName(job.address_id).slice(0, 100) }),
          description,
          isActive: true,
          source: 'odoo',
          odooSyncedAt: new Date(),
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true }
    );
  }

  // Jobs unpublished or archived in Odoo disappear from the website
  const hidden = await Vacancy.updateMany({ source: 'odoo', odooId: { $nin: seen }, isActive: true }, { $set: { isActive: false } });
  log(`connected: ${jobs.length} published job(s) in Odoo, ${hidden.modifiedCount} hidden on the website`);
  return { published: jobs.length, hidden: hidden.modifiedCount };
};

// ---------- Contact messages (website -> CRM lead) ----------

export const pushMessage = async (message) => {
  const [id] = await odooCall('crm.lead', 'create', {
    vals_list: [
      {
        name: `Website enquiry – ${message.name}${message.company ? ` (${message.company})` : ''}`,
        contact_name: message.name,
        email_from: message.email,
        phone: message.whatsapp || false,
        partner_name: message.company || false,
        description: message.message,
      },
    ],
  });
  return id;
};

// ---------- Job applications (website -> Recruitment applicant) ----------

// Odoo job position for an application. Vacancies created in the admin panel have no Odoo job
// yet: find one with the same name, or create it (unpublished, so Odoo's own website is unchanged).
const ensureOdooJob = async (vacancy, position) => {
  if (vacancy?.odooId) return vacancy.odooId;
  const name = String(vacancy?.title || position || '').trim();
  if (!name) return null;

  const [existing] = await odooCall('hr.job', 'search_read', {
    domain: [['name', '=ilike', name]],
    fields: ['id'],
    limit: 1,
    context: { active_test: false },
  });
  let jobId = existing?.id;
  if (!jobId) {
    const fields = await odooFields('hr.job');
    const vals = { name };
    if (fields.has('is_published')) vals.is_published = false;
    [jobId] = await odooCall('hr.job', 'create', { vals_list: [vals] });
    log(`created job "${name}" in Odoo (#${jobId})`);
  }
  // Remember it on the admin vacancy (source stays "admin", so the vacancy sync leaves it alone)
  if (vacancy?._id) await Vacancy.updateOne({ _id: vacancy._id }, { $set: { odooId: jobId } });
  return jobId;
};

export const pushApplication = async (application) => {
  const vacancy = application.vacancy?.odooId !== undefined ? application.vacancy : application.vacancy && (await Vacancy.findById(application.vacancy));
  const fields = await odooFields('hr.applicant');

  const notes = [
    `Position: ${application.position}`,
    application.experience && `Experience: ${application.experience}`,
    application.resumeUrl && `Resume: ${application.resumeUrl}`,
    application.resumeFile && `Resume: attached (${application.resumeName || 'file'})`,
    application.linkedin && `LinkedIn: ${application.linkedin}`,
    application.message && `\n${application.message}`,
  ]
    .filter(Boolean)
    .join('\n');

  const person = { partner_name: application.name, email_from: application.email, partner_phone: application.phone };
  const vals = {};
  const jobId = await ensureOdooJob(vacancy, application.position);
  if (jobId) vals.job_id = jobId;
  if (fields.has('name')) vals.name = `${application.position} – ${application.name}`; // required on Odoo 17
  if (fields.has('linkedin_profile') && application.linkedin) vals.linkedin_profile = application.linkedin;
  if (fields.has('applicant_notes')) vals.applicant_notes = notes;
  else if (fields.has('description')) vals.description = notes;

  // Odoo 18 keeps the person on a separate candidate record
  if (fields.has('candidate_id') && (await odooFields('hr.candidate').catch(() => null))) {
    const [candidateId] = await odooCall('hr.candidate', 'create', { vals_list: [person] });
    vals.candidate_id = candidateId;
  } else {
    Object.assign(vals, person);
  }

  const [id] = await odooCall('hr.applicant', 'create', { vals_list: [vals] });
  if (jobId) application.odooJobLinked = true;

  // Uploaded CV goes to the applicant as an attachment
  if (application.resumeFile) {
    const file = await StoredFile.findById(application.resumeFile);
    if (file?.data) {
      await odooCall('ir.attachment', 'create', {
        vals_list: [
          {
            name: application.resumeName || file.filename || 'resume',
            datas: Buffer.from(file.data).toString('base64'),
            mimetype: file.contentType,
            res_model: 'hr.applicant',
            res_id: id,
          },
        ],
      });
    }
  }
  return id;
};

// ---------- Push with retry ----------

const pushOne = async (doc, push, label) => {
  try {
    const id = await push(doc);
    doc.odooId = id;
    doc.odooSyncedAt = new Date();
    doc.odooError = '';
    // A new applicant starts in Odoo's first stage, which matches "new"
    if (label === 'application' && doc.status === 'new') doc.odooStatus = 'new';
    await doc.save();
    log(`${label} ${doc.id} -> Odoo #${id}`);
  } catch (err) {
    doc.odooAttempts = (doc.odooAttempts || 0) + 1;
    doc.odooError = err.message.slice(0, 500);
    await doc.save().catch(() => {});
    console.error(`[odoo] ${label} ${doc.id} failed (attempt ${doc.odooAttempts}):`, err.message);
  }
};

// Called right after a form is saved. Never throws, never delays the visitor's response.
export const queueMessage = (message) => {
  if (isOdooEnabled()) pushOne(message, pushMessage, 'message');
};
export const queueApplication = (application) => {
  if (isOdooEnabled()) pushOne(application, pushApplication, 'application');
};

const pending = { odooId: null, odooAttempts: { $lt: MAX_ATTEMPTS } };

export const retryPending = async () => {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // only the last 30 days
  const messages = await Message.find({ ...pending, createdAt: { $gte: since } }).limit(50);
  for (const m of messages) await pushOne(m, pushMessage, 'message');
  const applications = await Application.find({ ...pending, createdAt: { $gte: since } }).limit(50);
  for (const a of applications) await pushOne(a, pushApplication, 'application');
  return { messages: messages.length, applications: applications.length };
};

// Applicants sent before admin-panel jobs existed in Odoo: link them to their job now
export const linkMissingJobs = async () => {
  const apps = await Application.find({ odooId: { $ne: null }, odooJobLinked: { $ne: true } }).limit(50);
  let linked = 0;
  for (const app of apps) {
    try {
      const vacancy = app.vacancy && (await Vacancy.findById(app.vacancy));
      const jobId = await ensureOdooJob(vacancy, app.position);
      if (jobId) await odooCall('hr.applicant', 'write', { ids: [app.odooId], vals: { job_id: jobId } });
      await Application.updateOne({ _id: app._id }, { $set: { odooJobLinked: true } });
      if (jobId) linked += 1;
    } catch (err) {
      console.error(`[odoo] linking job for application ${app.id} failed:`, err.message);
    }
  }
  if (linked) log(`linked ${linked} applicant(s) to their Odoo job`);
  return linked;
};

export const runOdooSync = async () => {
  const vacancies = await syncVacancies();
  const retried = await retryPending();
  await linkMissingJobs().catch((err) => console.error('[odoo] job linking failed:', err.message));
  const statuses = await pullStatuses().catch((err) => {
    console.error('[odoo] status sync failed:', err.message);
    return { error: err.message };
  });
  if (statuses.updated) log(`statuses: ${statuses.updated} updated from Odoo`);
  return { vacancies, retried, statuses };
};

export const startOdooSync = () => {
  if (!isOdooEnabled()) {
    log('not configured (set ODOO_URL, ODOO_DB, ODOO_API_KEY to enable)');
    return;
  }
  const run = () => runOdooSync().catch((err) => console.error('[odoo] sync failed:', err.message));
  log(`enabled, syncing every ${env.odoo.syncMinutes} min`);
  setTimeout(run, 10 * 1000).unref();
  setInterval(run, env.odoo.syncMinutes * 60 * 1000).unref();
};
