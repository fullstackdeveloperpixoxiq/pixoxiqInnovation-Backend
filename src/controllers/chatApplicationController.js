import mongoose from 'mongoose';
import ChatConversation from '../models/ChatConversation.js';
import ChatEnquiry from '../models/ChatEnquiry.js';
import StoredFile from '../models/StoredFile.js';
import Vacancy from '../models/Vacancy.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import { sniffDocumentType } from '../middleware/upload.js';
import { resolveChatAccess } from '../ai/chatAccess.js';
import { CANDIDATE_FIELDS, cleanField, missingRequired } from '../ai/candidateService.js';
import { markEnquiryChanged, queueEnquirySync } from '../services/recruitmentSync.js';

// Public: the "Application" panel of a chatbot job enquiry. The candidate reviews the details
// collected in the conversation, optionally attaches a CV, gives consent and submits. Only
// then is anything sent to Odoo Recruitment (in the background). Access (logged in or email
// verified) and conversation ownership are checked on every request.

const RESUME_MAX_BYTES = 5 * 1024 * 1024;

// What the candidate sees about the sync: never internal errors or Odoo ids
const publicSyncStatus = (status) =>
  ({ not_submitted: 'draft', synced: 'received' }[status] || 'submitted');

const toPublic = (e) => ({
  id: String(e._id),
  vacancy: e.vacancy ? { id: String(e.vacancy), title: e.vacancyTitle } : null,
  email: e.email,
  authType: e.authType,
  candidate: Object.fromEntries(CANDIDATE_FIELDS.map((f) => [f, e.candidate?.[f] || ''])),
  missing: missingRequired(e.candidate),
  resume: e.resume?.file ? { name: e.resume.name, size: e.resume.size } : null,
  submitted: Boolean(e.submittedAt),
  submittedAt: e.submittedAt || null,
  status: publicSyncStatus(e.odoo?.status || 'not_submitted'),
});

const loadOwn = async (req) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw ApiError.notFound('Conversation not found');
  const conversation = await ChatConversation.findOne({ _id: req.params.id, visitorHash: req.visitorHash }).select('_id');
  if (!conversation) throw ApiError.notFound('Conversation not found');
  const access = await resolveChatAccess(req);
  if (!access) {
    const err = new ApiError(403, 'To help you with career-related questions, please log in or verify your email address.');
    err.details = { code: 'verification_required' };
    throw err;
  }
  return { conversation, access };
};

// GET /conversations/:id/application
export const getApplication = asyncHandler(async (req, res) => {
  const { conversation, access } = await loadOwn(req);
  const [enquiries, vacancies] = await Promise.all([
    ChatEnquiry.find({ conversation: conversation._id, type: 'job', email: access.email }).sort({ lastAt: -1 }),
    Vacancy.find({ isActive: true }).select('title').sort({ order: 1, createdAt: 1 }).lean(),
  ]);
  res.set('Cache-Control', 'no-store');
  res.json({
    success: true,
    data: {
      applications: enquiries.map(toPublic),
      vacancies: vacancies.map((v) => ({ id: String(v._id), title: v.title })),
    },
  });
});

// POST /conversations/:id/application (multipart; optional "resume" file)
export const submitApplication = asyncHandler(async (req, res) => {
  const { conversation, access } = await loadOwn(req);
  const body = req.body || {};
  if (!mongoose.isValidObjectId(body.enquiryId)) throw ApiError.badRequest('Application not found');
  const enquiry = await ChatEnquiry.findOne({ _id: body.enquiryId, conversation: conversation._id, type: 'job' });
  if (!enquiry) throw ApiError.notFound('Application not found');
  if (String(body.consent) !== 'true') {
    throw ApiError.badRequest('Please agree to sharing your details with the PIXOXIQ recruitment team to submit your application.');
  }

  // Details: as reviewed by the candidate (validated and trimmed); identity comes from the server
  const candidate = {};
  for (const field of CANDIDATE_FIELDS) {
    if (body[field] === undefined) {
      candidate[field] = enquiry.candidate?.[field] || '';
      continue;
    }
    const value = cleanField(field, body[field]);
    if (String(body[field]).trim() && !value) {
      throw ApiError.badRequest(field === 'phone' ? 'Enter a valid phone number' : field === 'linkedin' ? 'Enter a valid LinkedIn or portfolio URL (https://…)' : `Invalid ${field}`);
    }
    candidate[field] = value;
  }

  // Position: an open vacancy (only before the first submission), or free text
  if (!enquiry.submittedAt && body.vacancyId !== undefined) {
    if (body.vacancyId && mongoose.isValidObjectId(body.vacancyId)) {
      const vacancy = await Vacancy.findOne({ _id: body.vacancyId, isActive: true }).select('title');
      if (!vacancy) throw ApiError.badRequest('That vacancy is no longer open');
      const clash = String(vacancy._id) !== enquiry.vacancyKey && (await ChatEnquiry.exists({ conversation: conversation._id, type: 'job', vacancyKey: String(vacancy._id) }));
      if (clash) throw ApiError.badRequest('You already have an application for this vacancy in this conversation.');
      enquiry.vacancy = vacancy._id;
      enquiry.vacancyTitle = vacancy.title;
      enquiry.vacancyKey = String(vacancy._id);
      candidate.position = vacancy.title;
    } else if (!body.vacancyId) {
      if (enquiry.vacancyKey && (await ChatEnquiry.exists({ conversation: conversation._id, type: 'job', vacancyKey: '' }))) {
        throw ApiError.badRequest('You already have a general application in this conversation.');
      }
      enquiry.vacancy = null;
      enquiry.vacancyTitle = '';
      enquiry.vacancyKey = '';
    }
  }

  const missing = missingRequired(candidate);
  if (missing.length) throw ApiError.badRequest(`Please add your ${missing.map((m) => (m === 'message' ? 'enquiry message' : m)).join(', ')}.`);

  // CV (optional): type checked from the file content, kept private in the database
  const file = req.file;
  let stored = null;
  if (file) {
    if (file.size > RESUME_MAX_BYTES) throw ApiError.badRequest('CV is too large (max 5 MB)');
    const type = sniffDocumentType(file.buffer, file.originalname);
    if (!type) throw ApiError.badRequest('CV must be a PDF, DOCX, JPG, PNG or WEBP file');
    stored = await StoredFile.create({
      data: file.buffer,
      contentType: type,
      size: file.size,
      purpose: 'chat-enquiry/resume',
      filename: (file.originalname || 'cv').slice(0, 200),
    });
  }

  const previousFile = stored ? enquiry.resume?.file : null;
  const changed =
    Boolean(stored) || CANDIDATE_FIELDS.some((f) => (enquiry.candidate?.[f] || '') !== candidate[f]) || enquiry.isModified('vacancyKey');
  enquiry.candidate = candidate;
  // Identity always from the verified session / account
  enquiry.email = access.email;
  enquiry.authType = access.method === 'account' ? 'registered' : 'email_verified';
  enquiry.user = access.method === 'account' ? access.user : null;
  enquiry.name = candidate.name;
  if (stored) enquiry.resume = { file: stored._id, name: stored.filename, size: stored.size, contentType: stored.contentType, uploadedAt: new Date() };
  enquiry.lastAt = new Date();

  const firstSubmit = !enquiry.submittedAt;
  if (firstSubmit) {
    enquiry.consentAt = new Date();
    enquiry.submittedAt = new Date();
    enquiry.odoo.status = 'pending';
    enquiry.odoo.nextRetryAt = new Date();
    enquiry.odoo.attempts = 0;
  } else if (changed) {
    markEnquiryChanged(enquiry);
  }

  try {
    await enquiry.save();
  } catch (err) {
    if (stored) await StoredFile.deleteOne({ _id: stored._id }).catch(() => {});
    if (err.code === 11000) throw ApiError.badRequest('You already have an application for this position in this conversation.');
    throw err;
  }
  if (previousFile) await StoredFile.deleteOne({ _id: previousFile }).catch(() => {});
  if (firstSubmit || changed) queueEnquirySync(enquiry._id);

  res.status(firstSubmit ? 201 : 200).json({
    success: true,
    message: firstSubmit ? 'Your application has been submitted to the PIXOXIQ recruitment team.' : changed ? 'Your application has been updated.' : 'No changes.',
    data: toPublic(enquiry),
  });
});
