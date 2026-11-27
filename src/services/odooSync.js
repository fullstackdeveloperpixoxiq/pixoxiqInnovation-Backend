import Vacancy from '../models/Vacancy.js';
import Message from '../models/Message.js';
import Application from '../models/Application.js';
import StoredFile from '../models/StoredFile.js';
import SalesEnquiry from '../models/SalesEnquiry.js';
import Admin from '../models/Admin.js';
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

export const many2oneName = (value) => (Array.isArray(value) ? value[1] : '');

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

const attachFiles = async (model, resId, files) => {
  for (const { id, name } of files) {
    const file = await StoredFile.findById(id);
    if (!file?.data) continue;
    await odooCall('ir.attachment', 'create', {
      vals_list: [{ name: name || file.filename || 'file', datas: Buffer.from(file.data).toString('base64'), mimetype: file.contentType, res_model: model, res_id: resId }],
    });
  }
};

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
  // Files the visitor attached go to the lead too
  await attachFiles('crm.lead', id, (message.attachments || []).map((a) => ({ id: a.file, name: a.name })));
  return id;
};

// ---------- Job applications (website -> Recruitment applicant) ----------

// Odoo job position for an application. Vacancies created in the admin panel have no Odoo job
// yet: find one with the same name, or create it (unpublished, so Odoo's own website is unchanged).
export const ensureOdooJob = async (vacancy, position) => {
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

// ---------- Sales enquiries (sales portal -> CRM lead) ----------

const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const money = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const yesNo = (v) => (v ? 'Yes' : 'No');

const enquiryDescription = (e) => {
  const rows = e.products
    .map((p, i) => `<tr><td>${i + 1}</td><td>${esc(p.name)}${p.description ? `<br/><small>${esc(p.description)}</small>` : ''}</td><td>${p.quantity}</td><td>${money(p.price)}</td><td>${money(p.total)}</td></tr>`)
    .join('');
  return [
    `<p><b>Client:</b> ${esc(e.clientName)}<br/><b>Phone:</b> ${esc(e.phone)}<br/><b>Place:</b> ${esc(e.place)}`,
    e.email ? `<br/><b>Email:</b> ${esc(e.email)}` : '',
    e.company ? `<br/><b>Company:</b> ${esc(e.company)}` : '',
    '</p>',
    '<p><b>Requirements</b><br/>',
    `Has e-commerce: ${yesNo(e.hasEcommerce)} · We build e-commerce: ${yesNo(e.needsEcommerce)}<br/>`,
    `Has brand: ${yesNo(e.hasBrand)}${e.hasBrand && e.brandName ? ` (${esc(e.brandName)})` : ''} · We do branding: ${yesNo(e.needsBranding)}</p>`,
    e.notes ? `<p><b>Notes</b><br/>${esc(e.notes).replace(/\n/g, '<br/>')}</p>` : '',
    rows
      ? `<p><b>Products</b></p><table border="1" cellpadding="4"><tr><th>#</th><th>Product</th><th>Qty</th><th>Price</th><th>Total</th></tr>${rows}<tr><td colspan="4"><b>Grand total</b></td><td><b>${money(e.grandTotal)}</b></td></tr></table>`
      : '',
    `<p><small>Status: ${esc(e.status)} · Recorded via the sales portal</small></p>`,
  ].join('');
};

const userCache = new Map();
const odooUserByEmail = async (email) => {
  const key = String(email || '').toLowerCase();
  if (!key) return null;
  if (!userCache.has(key)) {
    const [user] = await odooCall('res.users', 'search_read', { domain: ['|', ['login', '=ilike', key], ['email', '=ilike', key]], fields: ['id'], limit: 1 });
    userCache.set(key, user?.id || null);
  }
  return userCache.get(key);
};

export const pushEnquiry = async (enquiry) => {
  const fields = await odooFields('crm.lead');
  const vals = {
    name: `Sales enquiry – ${enquiry.clientName}${enquiry.company ? ` (${enquiry.company})` : ''}`,
    contact_name: enquiry.clientName,
    phone: enquiry.phone,
    email_from: enquiry.email || false,
    partner_name: enquiry.company || false,
    description: enquiryDescription(enquiry),
  };
  if (fields.has('city')) vals.city = enquiry.place;
  if (fields.has('expected_revenue')) vals.expected_revenue = enquiry.grandTotal;
  // Recorded by the sales team, so it goes straight to CRM -> Sales -> Pipeline as an opportunity
  if (fields.has('type')) vals.type = 'opportunity';
  // Salesperson: the Odoo user with the same email as the portal user (so it shows in "My Pipeline")
  if (fields.has('user_id') && enquiry.createdBy) {
    const owner = await Admin.findById(enquiry.createdBy).select('email');
    const userId = owner && (await odooUserByEmail(owner.email));
    if (userId) vals.user_id = userId;
  }

  let id = enquiry.odooId;
  if (id) await odooCall('crm.lead', 'write', { ids: [id], vals });
  else [id] = await odooCall('crm.lead', 'create', { vals_list: [vals] });

  // Attach product images not sent before
  const sent = new Set((enquiry.odooFiles || []).map(String));
  const fresh = enquiry.products.flatMap((p) => p.images.map((img) => ({ id: img, name: p.name }))).filter((f) => !sent.has(String(f.id)));
  await attachFiles('crm.lead', id, fresh);
  enquiry.odooFiles = [...(enquiry.odooFiles || []), ...fresh.map((f) => f.id)];
  enquiry.odooDirty = false;
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
export const queueEnquiry = (enquiry) => {
  if (isOdooEnabled()) pushOne(enquiry, pushEnquiry, 'enquiry');
};

const pending = { odooId: null, odooAttempts: { $lt: MAX_ATTEMPTS } };

export const retryPending = async () => {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // only the last 30 days
  const messages = await Message.find({ ...pending, createdAt: { $gte: since } }).limit(50);
  for (const m of messages) await pushOne(m, pushMessage, 'message');
  const applications = await Application.find({ ...pending, createdAt: { $gte: since } }).limit(50);
  for (const a of applications) await pushOne(a, pushApplication, 'application');
  // Enquiries: new ones and ones edited since the last push
  const enquiries = await SalesEnquiry.find({ odooDirty: true, odooAttempts: { $lt: MAX_ATTEMPTS }, updatedAt: { $gte: since } }).limit(50);
  for (const e of enquiries) await pushOne(e, pushEnquiry, 'enquiry');
  return { messages: messages.length, applications: applications.length, enquiries: enquiries.length };
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

// Runs on a timer; skips quietly while Odoo is not configured, so settings saved later in the
// admin panel take effect without a restart
export const startOdooSync = () => {
  log(isOdooEnabled() ? `enabled, syncing every ${env.odoo.syncMinutes} min` : 'not configured yet (admin panel or ODOO_* variables)');
  const run = () => {
    if (!isOdooEnabled()) return;
    runOdooSync().catch((err) => console.error('[odoo] sync failed:', err.message));
  };
  setTimeout(run, 10 * 1000).unref();
  setInterval(run, env.odoo.syncMinutes * 60 * 1000).unref();
};
