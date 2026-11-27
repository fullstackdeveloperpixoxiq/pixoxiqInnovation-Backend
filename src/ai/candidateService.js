import Vacancy from '../models/Vacancy.js';
import { getChatClient } from './configService.js';
import { logAi } from './logger.js';

// Collects candidate details for chatbot job enquiries during the conversation.
// The configured chat model reads ONLY the candidate's own messages and returns the details
// they actually stated; nothing is guessed. Details from a verified account are kept, and
// the verified email is never changed. The candidate reviews everything and gives consent
// before it is sent to Odoo Recruitment (see the submit endpoint).

export const CANDIDATE_FIELDS = ['name', 'phone', 'position', 'message', 'skills', 'experience', 'qualification', 'location', 'linkedin'];
export const REQUIRED_FIELDS = ['name', 'position', 'message'];
const LIMITS = { name: 100, phone: 25, position: 120, message: 3000, skills: 500, experience: 200, qualification: 200, location: 120, linkedin: 300 };
const LABELS = {
  name: 'full name',
  phone: 'phone number',
  position: 'position of interest',
  message: 'what they are looking for (enquiry message)',
  skills: 'key skills',
  experience: 'experience',
  qualification: 'qualification',
  location: 'preferred location',
  linkedin: 'LinkedIn or portfolio URL',
};

const EXTRACT_PROMPT = `You extract job-candidate details from a visitor's own chat messages to the PIXOXIQ careers assistant.
Return ONLY details the visitor explicitly stated about themselves in the messages below. Never guess, infer or invent. Use "" for anything not stated.
Fields:
- name: the visitor's full name, only if they gave it ("I'm Priya Sharma")
- phone: their phone number as written
- position: the role they want. If it matches one of the open positions, copy that title exactly: {{VACANCIES}}
- message: one or two sentences, in the visitor's own terms, of what they are asking for or offering (e.g. "Wants to apply for the React Developer role; 3 years of React experience")
- skills, experience, qualification, location (preferred work location), linkedin (LinkedIn or portfolio URL)
Reply with ONLY a JSON object with exactly these keys: {"name":"","phone":"","position":"","message":"","skills":"","experience":"","qualification":"","location":"","linkedin":""}`;

const PHONE_RE = /^\+?[0-9][0-9\s().-]{6,22}$/;
const URL_RE = /^https?:\/\/[^\s]+$/i;

/** Cleans one value; returns '' when it is not acceptable */
export const cleanField = (field, value) => {
  let v = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  if (!v) return '';
  v = v.slice(0, LIMITS[field] || 200);
  if (field === 'phone' && !PHONE_RE.test(v)) return '';
  if (field === 'linkedin') {
    if (!/^https?:\/\//i.test(v) && /^(www\.|linkedin\.com|[a-z0-9-]+\.[a-z]{2,})/i.test(v)) v = `https://${v}`;
    if (!URL_RE.test(v)) return '';
  }
  return v;
};

export const missingRequired = (candidate = {}) => REQUIRED_FIELDS.filter((f) => !String(candidate[f] || '').trim());

const parse = (text) => {
  const match = String(text || '').match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const json = JSON.parse(match[0]);
    return Object.fromEntries(CANDIDATE_FIELDS.map((f) => [f, cleanField(f, json[f])]));
  } catch {
    return null;
  }
};

/**
 * Updates enquiry.candidate from the conversation (does not save).
 * @returns {Promise<boolean>} whether anything changed
 */
export const collectCandidateDetails = async ({ enquiry, userMessages }) => {
  if (!enquiry || enquiry.type !== 'job' || !userMessages.length) return false;
  let client;
  try {
    client = await getChatClient();
    const vacancies = await Vacancy.find({ isActive: true }).select('title').lean();
    const result = await client.chat({
      system: EXTRACT_PROMPT.replace('{{VACANCIES}}', vacancies.length ? vacancies.map((v) => v.title).join('; ') : 'none'),
      messages: [
        {
          role: 'user',
          content: `Visitor messages (oldest first):\n${userMessages
            .slice(-12)
            .map((m, i) => `${i + 1}. ${String(m).slice(0, 800)}`)
            .join('\n')}`,
        },
      ],
      temperature: 0,
      maxTokens: 500,
    });
    const found = parse(result.text);
    if (!found) return false;

    const current = enquiry.candidate || {};
    let changed = false;
    for (const field of CANDIDATE_FIELDS) {
      const value = found[field];
      if (!value || value === current[field]) continue;
      // Name and phone from a registered account are kept; free-text details follow the
      // latest conversation
      const locked = enquiry.authType === 'registered' && (field === 'name' || field === 'phone') && current[field];
      const fillOnly = ['name', 'phone', 'position'].includes(field) && current[field];
      if (locked || fillOnly) continue;
      enquiry.set(`candidate.${field}`, value);
      changed = true;
    }
    return changed;
  } catch (err) {
    await logAi({
      level: 'warn',
      source: 'chat',
      message: `Candidate detail collection failed: ${err.message}`,
      provider: client?.provider,
      model: client?.model,
      secrets: client?.secrets,
    });
    return false;
  }
};

/** Guidance for the answering model: what is known, what to ask next (one thing at a time) */
export const candidateInstructions = (enquiry) => {
  if (!enquiry || enquiry.type !== 'job') return '';
  const c = enquiry.candidate || {};
  const known = CANDIDATE_FIELDS.filter((f) => c[f]).map((f) => `${LABELS[f]}: ${c[f]}`);
  const missing = missingRequired(c).map((f) => LABELS[f]);
  const lines = [
    'Candidate details (job enquiry). The visitor is verified; their email is already known, never ask for it.',
    known.length ? `Already known (do not ask again): ${known.join('; ')}` : 'Nothing else is known yet.',
  ];
  if (enquiry.submittedAt) {
    lines.push('They have already submitted their application to the PIXOXIQ recruitment team. Answer their questions; they can update it with the "Application" panel below the chat.');
  } else if (missing.length) {
    lines.push(
      `Still needed before they can apply: ${missing.join(', ')}. While answering their question, naturally ask for at most ONE of these. Optional details (phone, skills, experience, qualification, preferred location, LinkedIn/portfolio, CV) may be mentioned once, never all at once.`
    );
  } else {
    lines.push('All required details are known. Tell them they can review the details and submit their application (with an optional CV) using the "Application" panel below the chat.');
  }
  return lines.join('\n');
};
