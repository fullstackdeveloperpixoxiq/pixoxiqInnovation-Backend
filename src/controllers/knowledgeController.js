import path from 'path';
import KnowledgeEntry, { KNOWLEDGE_CATEGORIES, KNOWLEDGE_STATUSES } from '../models/KnowledgeEntry.js';
import KnowledgeChunk from '../models/KnowledgeChunk.js';
import Service from '../models/Service.js';
import Vacancy from '../models/Vacancy.js';
import Certificate from '../models/Certificate.js';
import VisitingCard from '../models/VisitingCard.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import { paginate } from '../utils/queryBuilder.js';
import { sha256 } from '../ai/crypto.js';
import { cleanText, extractText, MAX_TEXT_LENGTH } from '../ai/textExtract.js';
import { enqueueIndexing, queueLength, reindexAll as reindexEverything } from '../ai/indexer.js';
import { markKnowledgeChanged, searchKnowledge } from '../ai/retrieval.js';
import { getEmbeddingClient } from '../ai/configService.js';
import { redact } from '../ai/redact.js';

// Knowledge base management: verified company information the assistant answers from.

const hashOf = ({ title, category, content }) => sha256(`${title}\n${category}\n${content}`);

const readString = (value, field, { max, required = false } = {}) => {
  if (value === undefined) {
    if (required) throw ApiError.badRequest(`${field} is required`);
    return undefined;
  }
  if (typeof value !== 'string') throw ApiError.badRequest(`${field} must be text`);
  const v = value.trim();
  if (required && !v) throw ApiError.badRequest(`${field} is required`);
  if (max && v.length > max) throw ApiError.badRequest(`${field} is too long (max ${max} characters)`);
  return v;
};

// Saves new text on an entry and schedules re-indexing. Old chunks are removed right away so
// outdated information is never served while the new version is being processed.
const applyContent = async (entry, { title, category, content }) => {
  const next = { title: title ?? entry.title, category: category ?? entry.category, content: content ?? entry.content };
  const hash = hashOf(next);
  if (hash === entry.contentHash && entry.status !== 'failed') return false;
  entry.set({ ...next, contentLength: next.content.length, contentHash: hash, status: 'pending', error: '', chunkCount: 0 });
  await KnowledgeChunk.deleteMany({ entry: entry._id });
  return true;
};

const parseActive = (value) => (value === undefined ? undefined : value === true || value === 'true');

export const listEntries = asyncHandler(async (req, res) => {
  const { items, pagination } = await paginate(KnowledgeEntry, req.query, {
    searchFields: ['title', 'category', 'file.name'],
    filterFields: ['category', 'status', 'sourceType', 'isActive'],
    defaultSort: '-updatedAt',
  });
  const grouped = await KnowledgeEntry.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]);
  const counts = Object.fromEntries(KNOWLEDGE_STATUSES.map((s) => [s, 0]));
  grouped.forEach((g) => {
    counts[g._id] = g.count;
  });
  res.json({ success: true, data: items, pagination, counts, queue: queueLength() });
});

export const listCategories = asyncHandler(async (req, res) => {
  const used = await KnowledgeEntry.distinct('category');
  res.json({ success: true, data: [...new Set([...KNOWLEDGE_CATEGORIES, ...used])].sort((a, b) => a.localeCompare(b)) });
});

export const getEntry = asyncHandler(async (req, res) => {
  const entry = await KnowledgeEntry.findById(req.params.id).select('+content');
  if (!entry) throw ApiError.notFound('Knowledge entry not found');
  res.json({ success: true, data: { ...entry.toJSON(), content: entry.content } });
});

export const createEntry = asyncHandler(async (req, res) => {
  const title = readString(req.body.title, 'Title', { max: 200, required: true });
  const category = readString(req.body.category, 'Category', { max: 80, required: true });
  const content = cleanText(readString(req.body.content, 'Content', { max: MAX_TEXT_LENGTH, required: true }));
  if (!content) throw ApiError.badRequest('Content is required');

  const entry = await KnowledgeEntry.create({
    title,
    category,
    content,
    contentLength: content.length,
    contentHash: hashOf({ title, category, content }),
    sourceType: 'manual',
    isActive: parseActive(req.body.isActive) ?? true,
    createdBy: req.admin._id,
    updatedBy: req.admin._id,
  });
  enqueueIndexing(entry._id);
  res.status(201).json({ success: true, message: 'Knowledge entry added. Indexing has started.', data: entry });
});

export const uploadDocument = asyncHandler(async (req, res) => {
  if (!req.file) throw ApiError.badRequest('Choose a file to upload');
  const category = readString(req.body.category, 'Category', { max: 80, required: true });
  const fallbackTitle = path.basename(req.file.originalname, path.extname(req.file.originalname)).replace(/[_-]+/g, ' ').trim();
  const title = readString(req.body.title, 'Title', { max: 200 }) || fallbackTitle.slice(0, 200) || 'Untitled document';
  const content = await extractText(req.file);

  const entry = await KnowledgeEntry.create({
    title,
    category,
    content,
    contentLength: content.length,
    contentHash: hashOf({ title, category, content }),
    sourceType: 'file',
    file: { name: req.file.originalname.slice(0, 255), mimeType: req.file.mimetype, size: req.file.size },
    isActive: parseActive(req.body.isActive) ?? true,
    createdBy: req.admin._id,
    updatedBy: req.admin._id,
  });
  enqueueIndexing(entry._id);
  res.status(201).json({
    success: true,
    message: `"${title}" uploaded (${content.length.toLocaleString()} characters extracted). Indexing has started.`,
    data: entry,
  });
});

export const updateEntry = asyncHandler(async (req, res) => {
  const entry = await KnowledgeEntry.findById(req.params.id).select('+content');
  if (!entry) throw ApiError.notFound('Knowledge entry not found');

  const title = readString(req.body.title, 'Title', { max: 200 });
  const category = readString(req.body.category, 'Category', { max: 80 });
  let content = readString(req.body.content, 'Content', { max: MAX_TEXT_LENGTH });
  if (content !== undefined) {
    content = cleanText(content);
    if (!content) throw ApiError.badRequest('Content cannot be empty');
  }
  if (title === '' || category === '') throw ApiError.badRequest('Title and category cannot be empty');

  const changed = await applyContent(entry, { title, category, content });
  const isActive = parseActive(req.body.isActive);
  if (isActive !== undefined) entry.isActive = isActive;
  entry.updatedBy = req.admin._id;
  await entry.save();
  markKnowledgeChanged();
  if (changed) enqueueIndexing(entry._id);

  res.json({ success: true, message: changed ? 'Entry updated. Re-indexing has started.' : 'Entry updated', data: entry });
});

// Replaces the document of a file entry with a new version
export const replaceDocument = asyncHandler(async (req, res) => {
  if (!req.file) throw ApiError.badRequest('Choose a file to upload');
  const entry = await KnowledgeEntry.findById(req.params.id).select('+content');
  if (!entry) throw ApiError.notFound('Knowledge entry not found');
  const content = await extractText(req.file);
  await applyContent(entry, { content });
  entry.sourceType = 'file';
  entry.file = { name: req.file.originalname.slice(0, 255), mimeType: req.file.mimetype, size: req.file.size };
  entry.updatedBy = req.admin._id;
  await entry.save();
  markKnowledgeChanged();
  enqueueIndexing(entry._id);
  res.json({ success: true, message: 'Document replaced. Re-indexing has started.', data: entry });
});

export const deleteEntry = asyncHandler(async (req, res) => {
  const entry = await KnowledgeEntry.findByIdAndDelete(req.params.id);
  if (!entry) throw ApiError.notFound('Knowledge entry not found');
  await KnowledgeChunk.deleteMany({ entry: entry._id });
  markKnowledgeChanged();
  res.json({ success: true, message: 'Knowledge entry deleted', data: { id: entry.id } });
});

export const reindexEntry = asyncHandler(async (req, res) => {
  const entry = await KnowledgeEntry.findByIdAndUpdate(req.params.id, { $set: { status: 'pending', error: '' } }, { new: true });
  if (!entry) throw ApiError.notFound('Knowledge entry not found');
  enqueueIndexing(entry._id);
  res.json({ success: true, message: 'Re-indexing started', data: entry });
});

export const reindexAll = asyncHandler(async (req, res) => {
  const count = await reindexEverything();
  res.json({ success: true, message: `Re-indexing ${count} entries`, data: { count } });
});

// Retrieval preview: which knowledge would be used to answer this question
export const searchTest = asyncHandler(async (req, res) => {
  const query = readString(req.body.query, 'Query', { max: 1000, required: true });
  const embeddingClient = await getEmbeddingClient();
  try {
    const { mode, results } = await searchKnowledge(query, {
      topK: Math.min(Number(req.body.topK) || 8, 20),
      minRelevance: 0,
      embeddingClient,
    });
    res.json({ success: true, data: { mode, results: results.map((r) => ({ ...r, text: r.text.slice(0, 600) })) } });
  } catch (err) {
    throw new ApiError(502, redact(`Search failed: ${err.message}`, embeddingClient?.secrets));
  }
});

// ---------- Import from website content ----------

const lines = (...parts) => parts.filter((p) => p !== undefined && p !== null && String(p).trim() !== '').join('\n');
const fmtDate = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');

const buildWebsiteEntries = async () => {
  const [services, vacancies, certificates, card] = await Promise.all([
    Service.find({ isActive: true }).sort('order'),
    Vacancy.find({ isActive: true }).sort('order'),
    Certificate.find({ isActive: true }).sort('order'),
    VisitingCard.findOne(),
  ]);
  const site = (card?.website || 'https://www.pixoxiq.com').replace(/\/+$/, '');

  const entries = [];
  services.forEach((s) =>
    entries.push({
      sourceRef: `service:${s.id}`,
      title: `Service: ${s.title}`,
      category: 'Products & services',
      content: lines(
        `PIXOXIQ service: ${s.title}`,
        s.description,
        s.content,
        s.features?.length ? `Key features:\n${s.features.map((f) => `- ${f}`).join('\n')}` : '',
        `Service page: ${site}/services/${s.slug}`
      ),
    })
  );
  vacancies.forEach((v) =>
    entries.push({
      sourceRef: `vacancy:${v.id}`,
      title: `Open position: ${v.title}`,
      category: 'Careers',
      content: lines(
        `PIXOXIQ is hiring: ${v.title}`,
        `Department: ${v.department}`,
        `Location: ${v.location}`,
        `Job type: ${v.type}, work mode: ${v.mode}`,
        v.experience && `Experience: ${v.experience}`,
        v.salary && `Salary: ${v.salary}`,
        v.deadline && `Application deadline: ${fmtDate(v.deadline)}`,
        v.description,
        v.requirements?.length ? `Requirements:\n${v.requirements.map((r) => `- ${r}`).join('\n')}` : '',
        `Apply on the careers page: ${site}/careers`
      ),
    })
  );
  certificates.forEach((c) =>
    entries.push({
      sourceRef: `certificate:${c.id}`,
      title: `Certification: ${c.title}`,
      category: 'Certifications',
      content: lines(
        `PIXOXIQ holds the certification/recognition: ${c.title}`,
        c.subtitle,
        c.issuer && `Issued by: ${c.issuer}`,
        c.issueDate && `Issue date: ${fmtDate(c.issueDate)}`,
        c.expiryDate && `Valid until: ${fmtDate(c.expiryDate)}`,
        c.description,
        c.credentialUrl && `Verification link: ${c.credentialUrl}`
      ),
    })
  );
  if (card) {
    const socials = Object.entries(card.socials?.toObject?.() || card.socials || {}).filter(([, url]) => url);
    entries.push({
      sourceRef: 'visiting-card',
      title: 'Contact information',
      category: 'Contact information',
      content: lines(
        `Company: ${card.company}`,
        card.name && `${card.designation || 'Contact'}: ${card.name}`,
        card.email && `Email: ${card.email}`,
        card.phone && `Phone: ${card.phone}`,
        card.whatsapp && `WhatsApp: ${card.whatsapp}`,
        card.website && `Website: ${card.website}`,
        card.location && `Location: ${card.location}`,
        card.locationUrl && `Google Maps: ${card.locationUrl}`,
        card.workingHours && `Working hours: ${card.workingHours}`,
        socials.length ? `Social media:\n${socials.map(([k, url]) => `- ${k}: ${url}`).join('\n')}` : '',
        `Contact form: ${site}/#contact`,
        card.about && `About:\n${card.about}`
      ),
    });
  }
  return entries;
};

export const syncWebsite = asyncHandler(async (req, res) => {
  const desired = await buildWebsiteEntries();
  const existing = await KnowledgeEntry.find({ sourceType: 'website' }).select('+content');
  const byRef = new Map(existing.map((e) => [e.sourceRef, e]));
  let created = 0;
  let updated = 0;

  for (const item of desired) {
    const content = cleanText(item.content);
    const current = byRef.get(item.sourceRef);
    if (current) {
      byRef.delete(item.sourceRef);
      if (await applyContent(current, { title: item.title, category: item.category, content })) {
        current.updatedBy = req.admin._id;
        await current.save();
        enqueueIndexing(current._id);
        updated += 1;
      }
    } else {
      const entry = await KnowledgeEntry.create({
        ...item,
        content,
        contentLength: content.length,
        contentHash: hashOf({ ...item, content }),
        sourceType: 'website',
        createdBy: req.admin._id,
        updatedBy: req.admin._id,
      });
      enqueueIndexing(entry._id);
      created += 1;
    }
  }

  // Website content that was deleted or hidden is removed from the knowledge base too
  const staleIds = [...byRef.values()].map((e) => e._id);
  if (staleIds.length) {
    await KnowledgeEntry.deleteMany({ _id: { $in: staleIds } });
    await KnowledgeChunk.deleteMany({ entry: { $in: staleIds } });
  }
  markKnowledgeChanged();

  res.json({
    success: true,
    message: `Website content synced: ${created} added, ${updated} updated, ${staleIds.length} removed`,
    data: { created, updated, removed: staleIds.length },
  });
});
