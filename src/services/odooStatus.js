import Application from '../models/Application.js';
import { isOdooEnabled, odooCall, odooFields } from './odoo.js';

// Two-way sync of an application's status with the applicant's stage in Odoo Recruitment.
//
//   admin panel   <->  Odoo
//   new                New
//   reviewing          Qualification / Initial Qualification
//   shortlisted        Shortlisted (stage added by hand in Odoo)
//   interview          First Interview (Second Interview / Contract Proposal also read as interview)
//   hired              the stage marked "hired" (Contract Signed)
//   rejected           refused (Refuse button), not a stage
//
// `odooStatus` on each application remembers the status both sides last agreed on, so the
// periodic pull only overwrites the admin panel when the stage was really changed in Odoo.

const log = (...args) => console.log('[odoo]', ...args);
const norm = (s) => String(s || '').trim().toLowerCase();

const STAGE_NAMES = {
  new: ['new'],
  reviewing: ['qualification', 'initial qualification'],
  shortlisted: ['shortlisted', 'shortlist'],
  interview: ['first interview', 'interview'],
};
const READ_AS_INTERVIEW = ['first interview', 'second interview', 'interview', 'contract proposal'];

// Stages are read once per sync (cheap) so renamed or new stages are picked up
const loadStages = async () => {
  const fields = await odooFields('hr.recruitment.stage');
  const stages = await odooCall('hr.recruitment.stage', 'search_read', {
    domain: [],
    fields: ['name', 'sequence', ...(fields.has('hired_stage') ? ['hired_stage'] : [])],
  });
  return stages.sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
};

const stageFor = (stages, status) => {
  if (status === 'hired') return stages.find((s) => s.hired_stage) || stages.find((s) => norm(s.name) === 'contract signed');
  const names = STAGE_NAMES[status] || [];
  for (const name of names) {
    const stage = stages.find((s) => norm(s.name) === name);
    if (stage) return stage;
  }
  return null;
};

const statusFromApplicant = (applicant, stages) => {
  if (applicant.refuse_reason_id || applicant.application_status === 'refused') return 'rejected';
  const stage = stages.find((s) => s.id === (Array.isArray(applicant.stage_id) ? applicant.stage_id[0] : applicant.stage_id));
  if (applicant.application_status === 'hired' || stage?.hired_stage) return 'hired';
  const name = norm(stage?.name);
  if (STAGE_NAMES.new.includes(name)) return 'new';
  if (STAGE_NAMES.reviewing.includes(name)) return 'reviewing';
  if (STAGE_NAMES.shortlisted.includes(name)) return 'shortlisted';
  if (READ_AS_INTERVIEW.includes(name)) return 'interview';
  if (name === 'contract signed') return 'hired';
  return null; // unknown custom stage: leave the admin panel status alone
};

let refuseReasonId;
const getRefuseReason = async () => {
  if (refuseReasonId === undefined) {
    const [reason] = await odooCall('hr.applicant.refuse.reason', 'search_read', { domain: [], fields: ['name'], limit: 1 });
    refuseReasonId = reason?.id || null;
  }
  return refuseReasonId;
};

// ---------- admin panel -> Odoo ----------

export const pushStatus = async (application) => {
  if (!isOdooEnabled() || !application.odooId) return;
  const status = application.status;
  try {
    const fields = await odooFields('hr.applicant');
    const vals = {};

    if (status === 'rejected') {
      const reason = fields.has('refuse_reason_id') ? await getRefuseReason() : null;
      if (reason) vals.refuse_reason_id = reason;
      if (fields.has('active')) vals.active = false;
    } else {
      const stage = stageFor(await loadStages(), status);
      if (!stage) throw new Error(`No Odoo stage matches "${status}". Add it in Recruitment (e.g. a "Shortlisted" stage).`);
      vals.stage_id = stage.id;
      // Moving out of "rejected" brings the applicant back
      if (fields.has('refuse_reason_id')) vals.refuse_reason_id = false;
      if (fields.has('active')) vals.active = true;
    }

    await odooCall('hr.applicant', 'write', { ids: [application.odooId], vals });
    await Application.updateOne({ _id: application._id }, { $set: { odooStatus: status, odooError: '' } });
    log(`application ${application.id} status -> ${status} in Odoo`);
  } catch (err) {
    await Application.updateOne({ _id: application._id }, { $set: { odooError: `Status: ${err.message}`.slice(0, 500) } }).catch(() => {});
    console.error(`[odoo] status push for application ${application.id} failed:`, err.message);
  }
};

// ---------- Odoo -> admin panel ----------

export const pullStatuses = async () => {
  const apps = await Application.find({ odooId: { $ne: null } }).select('status odooId odooStatus').limit(500);
  if (!apps.length) return { checked: 0, updated: 0 };

  const [stages, fields] = await Promise.all([loadStages(), odooFields('hr.applicant')]);
  const wanted = ['stage_id', 'refuse_reason_id', 'application_status', 'active'].filter((f) => fields.has(f));
  const applicants = await odooCall('hr.applicant', 'search_read', {
    domain: [['id', 'in', apps.map((a) => a.odooId)]],
    fields: wanted,
    context: { active_test: false }, // refused applicants are archived
  });
  const byId = new Map(applicants.map((a) => [a.id, a]));

  let updated = 0;
  for (const app of apps) {
    const applicant = byId.get(app.odooId);
    if (!applicant) continue;
    const odooNow = statusFromApplicant(applicant, stages);
    if (!odooNow) continue;
    if (!app.odooStatus) {
      // First check after this feature was added: just remember Odoo's value
      if (odooNow === app.status) await Application.updateOne({ _id: app._id }, { $set: { odooStatus: odooNow } });
      else await pushStatus(app); // admin panel already moved on: bring Odoo in line
      continue;
    }
    if (odooNow !== app.odooStatus) {
      // HR changed the stage in Odoo since the last sync
      await Application.updateOne({ _id: app._id }, { $set: { status: odooNow, odooStatus: odooNow } });
      updated += 1;
      log(`application ${app.id} status <- ${odooNow} from Odoo`);
    }
  }
  return { checked: apps.length, updated };
};
