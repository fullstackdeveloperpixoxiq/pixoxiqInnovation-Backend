import Service from '../models/Service.js';
import Vacancy from '../models/Vacancy.js';
import Certificate from '../models/Certificate.js';
import VisitingCard from '../models/VisitingCard.js';
import { companyDataVersion } from '../utils/changeTracker.js';
import { tokenize } from './retrieval.js';

// Structured company data read live from the website's own collections (the same ones the
// admin panel edits and the public site shows). It does not depend on vector search or
// knowledge-base uploads: published services are always given to the model, so "what
// services do you offer?" lists every published service, and changes made in the admin panel
// apply to the next question. Only published (isActive) records are used.

const MAX_AGE_MS = 60 * 1000; // safety net in case a change bypassed the model hooks
const MAX_SERVICE_DETAILS = 3;

let cache = { version: 0, at: 0, data: null };

const load = async () => {
  if (cache.data && cache.version === companyDataVersion() && Date.now() - cache.at < MAX_AGE_MS) return cache.data;
  const version = companyDataVersion();
  const [services, vacancies, certificates, card] = await Promise.all([
    Service.find({ isActive: true }).sort({ order: 1, createdAt: 1 }).lean(),
    Vacancy.find({ isActive: true }).sort({ order: 1, createdAt: 1 }).lean(),
    Certificate.find({ isActive: true }).sort({ order: 1, createdAt: 1 }).lean(),
    VisitingCard.findOne().lean(),
  ]);
  const data = {
    services: services.map((s) => ({ ...s, terms: new Set(tokenize(`${s.title} ${s.slug} ${(s.features || []).join(' ')}`)) })),
    vacancies,
    certificates,
    card,
  };
  cache = { version, at: Date.now(), data };
  return data;
};

const join = (...parts) => parts.filter((p) => p !== undefined && p !== null && String(p).trim() !== '').join('\n');
const fmtDate = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');
const siteOf = (card) => (card?.website || '').replace(/\/+$/, '');

const CAREER_RE = /\b(job|jobs|career|careers|hiring|hire|vacanc\w*|opening|openings|position|positions|intern\w*|apply|recruit\w*|work (?:at|for|with) (?:you|pixoxiq))\b/i;
const CERT_RE = /\b(certif\w*|iso|accredit\w*|award\w*|recogni\w*|registered|registration|startup india|msme|compliance|credential\w*)\b/i;

// Services named or strongly described by the question, best match first
const matchServices = (services, query) => {
  const q = String(query).toLowerCase();
  const qTerms = new Set(tokenize(query));
  return services
    .map((s) => {
      let score = 0;
      if (q.includes(s.title.toLowerCase())) score += 10;
      if (s.slug && q.includes(s.slug.replace(/-/g, ' '))) score += 5;
      s.terms.forEach((t) => {
        if (qTerms.has(t)) score += 1;
      });
      return { s, score };
    })
    .filter((x) => x.score >= 2)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_SERVICE_DETAILS)
    .map((x) => x.s);
};

/**
 * Builds the live company-data sources for a question. Each item becomes a numbered
 * <source> in the system prompt, before the knowledge-base sources.
 * @returns {Promise<Array<{ title, category, text }>>}
 */
export const getCompanyContexts = async (query) => {
  const { services, vacancies, certificates, card } = await load();
  const site = siteOf(card);
  const contexts = [];

  if (services.length) {
    contexts.push({
      title: 'PIXOXIQ services (published on the website)',
      category: 'Products & services',
      text: join(
        `PIXOXIQ currently offers these ${services.length} services. This is the complete, current list:`,
        ...services.map((s, i) =>
          join(
            `${i + 1}. ${s.title}: ${s.description}`,
            s.features?.length ? `   Key features: ${s.features.join('; ')}` : '',
            `   Service page: ${site}/services/${s.slug}`
          )
        )
      ),
    });
    matchServices(services, query).forEach((s) => {
      if (!s.content?.trim()) return; // the catalog already holds its description and features
      contexts.push({ title: `Service details: ${s.title}`, category: 'Products & services', text: join(`PIXOXIQ service: ${s.title}`, s.description, s.content) });
    });
  } else {
    contexts.push({ title: 'PIXOXIQ services', category: 'Products & services', text: 'No services are currently published on the PIXOXIQ website.' });
  }

  if (card) {
    const socials = Object.entries(card.socials || {}).filter(([, url]) => url);
    contexts.push({
      title: 'PIXOXIQ contact information',
      category: 'Contact information',
      text: join(
        card.company && `Company: ${card.company}`,
        card.email && `Email: ${card.email}`,
        card.phone && `Phone: ${card.phone}`,
        card.whatsapp && `WhatsApp: ${card.whatsapp}`,
        card.website && `Website: ${card.website}`,
        card.location && `Location: ${card.location}`,
        card.locationUrl && `Google Maps: ${card.locationUrl}`,
        card.workingHours && `Working hours: ${card.workingHours}`,
        socials.length ? `Social media: ${socials.map(([k, url]) => `${k}: ${url}`).join(', ')}` : '',
        `Contact form: ${site}/#contact`,
        card.about && `About PIXOXIQ: ${card.about}`
      ),
    });
  }

  if (CERT_RE.test(query) && certificates.length) {
    contexts.push({
      title: 'PIXOXIQ certifications and recognitions',
      category: 'Certifications',
      text: certificates
        .map((c) =>
          join(
            `- ${c.title}${c.subtitle ? ` (${c.subtitle})` : ''}`,
            c.issuer && `  Issued by: ${c.issuer}`,
            c.issueDate && `  Issue date: ${fmtDate(c.issueDate)}`,
            c.expiryDate && `  Valid until: ${fmtDate(c.expiryDate)}`,
            c.description && `  ${c.description}`,
            c.credentialUrl && `  Verification: ${c.credentialUrl}`
          )
        )
        .join('\n'),
    });
  }

  if (CAREER_RE.test(query)) {
    contexts.push({
      title: 'Open positions at PIXOXIQ',
      category: 'Careers',
      text: vacancies.length
        ? join(
            ...vacancies.map((v) =>
              join(
                `- ${v.title} (${[v.department, v.location, v.type, v.mode].filter(Boolean).join(', ')})`,
                v.experience && `  Experience: ${v.experience}`,
                v.salary && `  Salary: ${v.salary}`,
                v.deadline && `  Apply by: ${fmtDate(v.deadline)}`,
                v.description && `  ${v.description}`,
                v.requirements?.length ? `  Requirements: ${v.requirements.join('; ')}` : ''
              )
            ),
            `Apply on the careers page: ${site}/careers`
          )
        : `There are no open positions published right now. Careers page: ${site}/careers`,
    });
  }

  return contexts;
};
