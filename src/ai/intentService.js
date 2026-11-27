import Vacancy from '../models/Vacancy.js';
import { getChatClient } from './configService.js';
import { logAi } from './logger.js';

// Intent classification layer of the AI assistant. The configured chat model reads the
// recent conversation and decides what the visitor actually wants (not which keywords they
// used). The result decides whether a job enquiry needs a logged-in / email-verified visitor,
// so it is computed on the server for every question and never taken from the browser.

export const INTENTS = { JOB: 'JOB_ENQUIRY', WEBSITE: 'WEBSITE_ENQUIRY', AMBIGUOUS: 'AMBIGUOUS' };

// Finer category of non-recruitment questions (admin "Normal / General Queries")
export const TOPICS = ['company', 'services', 'technology', 'website', 'business', 'contact', 'general', 'other'];

// Below this confidence the visitor is asked what they mean instead of guessing
export const MIN_CONFIDENCE = 0.6;

const CLASSIFIER_PROMPT = `You are the intent classifier of the PIXOXIQ website assistant. Decide what the visitor wants with their LATEST message, using the earlier messages as context (a short follow-up like "what about the salary?" continues the earlier topic).

Categories:
- JOB_ENQUIRY: the visitor wants to work at PIXOXIQ or learn about working there: job vacancies, recruitment, careers, how to apply, sending a resume/CV, interviews, eligibility, internships, salary or employment terms.
- WEBSITE_ENQUIRY: anything else about PIXOXIQ as a company or business: company information, services, products and solutions, technologies, website navigation, business/project enquiries, pricing of services, contact details, greetings and general questions.
- AMBIGUOUS: you genuinely cannot tell which of the two the visitor means (e.g. "do you have openings?" could be job openings or project slots; "I want to join" could be a team or a newsletter).

Rules:
- Judge the intent, not single words. "Do you build recruitment software?" or "Can you make a careers page for my site?" is WEBSITE_ENQUIRY. "I am a React developer, do you need people?" is JOB_ENQUIRY.
- A business asking to HIRE PIXOXIQ for a project is WEBSITE_ENQUIRY.
- If the visitor already answered a clarifying question, classify using that answer.
- "vacancy": when the visitor asks about one of the open positions listed below, copy its title exactly; otherwise "".
- "clarification": only for AMBIGUOUS, one short friendly question asking which they mean; otherwise "".
- "topic": for WEBSITE_ENQUIRY the closest of: company (about PIXOXIQ, team, history, certifications), services (services, products, solutions, pricing), technology (technologies, tech stack), website (navigating this site), business (project or partnership enquiries), contact (contact details, location, hours), general (general-knowledge questions not about PIXOXIQ), other (greetings, small talk, anything else). For JOB_ENQUIRY use "recruitment"; for AMBIGUOUS use "".

Open positions: {{VACANCIES}}

Reply with ONLY a JSON object, no other text:
{"category":"JOB_ENQUIRY|WEBSITE_ENQUIRY|AMBIGUOUS","confidence":0.0-1.0,"vacancy":"","clarification":"","topic":""}`;

const DEFAULT_CLARIFICATION =
  'Just to make sure I help with the right thing: are you asking about career opportunities at PIXOXIQ, or about our services for your business?';

const parse = (text) => {
  const match = String(text || '').match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const json = JSON.parse(match[0]);
    if (!Object.values(INTENTS).includes(json.category)) return null;
    const confidence = Math.min(1, Math.max(0, Number(json.confidence)));
    return {
      category: json.category,
      confidence: Number.isFinite(confidence) ? confidence : 0,
      vacancy: typeof json.vacancy === 'string' ? json.vacancy.trim() : '',
      clarification: typeof json.clarification === 'string' ? json.clarification.trim().slice(0, 400) : '',
      topic: TOPICS.includes(json.topic) ? json.topic : '',
    };
  } catch {
    return null;
  }
};

const transcript = (history, message) =>
  [...history.slice(-6), { role: 'user', content: message }]
    .map((m) => `${m.role === 'user' ? 'Visitor' : 'Assistant'}: ${String(m.content).slice(0, 800)}`)
    .join('\n');

/**
 * Classifies the latest visitor message in its conversation context.
 * @returns {Promise<{ category, confidence, clarification, vacancy: {id,title}|null, usage, failed }>}
 *   On a classifier failure the previous intent of the conversation is kept (or WEBSITE with
 *   confidence 0). That is safe because recruitment data is only ever given to the answering
 *   model for authorised visitors.
 */
export const classifyIntent = async ({ history = [], message, previous = '', signal }) => {
  const vacancies = await Vacancy.find({ isActive: true }).select('title').lean();
  const fallback = {
    category: previous === INTENTS.JOB ? INTENTS.JOB : INTENTS.WEBSITE,
    confidence: 0,
    clarification: '',
    vacancy: null,
    topic: '',
    usage: null,
    failed: true,
  };

  let client;
  try {
    client = await getChatClient();
    const result = await client.chat({
      system: CLASSIFIER_PROMPT.replace('{{VACANCIES}}', vacancies.length ? vacancies.map((v) => v.title).join('; ') : 'none'),
      messages: [{ role: 'user', content: `Conversation:\n${transcript(history, message)}\n\nClassify the visitor's latest message.` }],
      temperature: 0,
      maxTokens: 400,
      signal,
    });
    const parsed = parse(result.text);
    if (!parsed) {
      await logAi({ level: 'warn', source: 'chat', message: 'Intent classifier returned an unreadable answer; kept the previous intent', provider: client.provider, model: client.model });
      return fallback;
    }

    let { category, clarification } = parsed;
    // Not sure enough: ask instead of guessing
    if (category !== INTENTS.AMBIGUOUS && parsed.confidence < MIN_CONFIDENCE) category = INTENTS.AMBIGUOUS;
    if (category === INTENTS.AMBIGUOUS && !clarification) clarification = DEFAULT_CLARIFICATION;

    const vacancy =
      category === INTENTS.JOB && parsed.vacancy
        ? vacancies.find((v) => v.title.toLowerCase() === parsed.vacancy.toLowerCase()) || null
        : null;

    return {
      category,
      confidence: parsed.confidence,
      topic: category === INTENTS.WEBSITE ? parsed.topic || 'other' : category === INTENTS.JOB ? 'recruitment' : '',
      clarification: category === INTENTS.AMBIGUOUS ? clarification : '',
      vacancy: vacancy ? { id: vacancy._id, title: vacancy.title } : null,
      usage: result.usage || null,
      failed: false,
    };
  } catch (err) {
    if (err.code === 'aborted') throw err;
    await logAi({
      level: 'warn',
      source: 'chat',
      message: `Intent classification failed, kept the previous intent: ${err.message}`,
      code: err.code,
      provider: client?.provider,
      model: client?.model,
      secrets: client?.secrets,
    });
    return fallback;
  }
};
