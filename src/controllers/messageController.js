import Message, { MESSAGE_STATUSES } from '../models/Message.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import { paginate } from '../utils/queryBuilder.js';
import { pickFields } from './crudFactory.js';
import { queueMessage } from '../services/odooSync.js';
import StoredFile from '../models/StoredFile.js';
import { sniffDocumentType } from '../middleware/upload.js';

export const MAX_ATTACHMENTS = 3;
const ATTACHMENT_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
const removeFiles = (ids) => ids.length && StoredFile.deleteMany({ _id: { $in: ids } }).catch(() => {});

// ---------- Public ----------

export const submitMessage = asyncHandler(async (req, res) => {
  // Honeypot field: real users never fill it, bots usually do
  if (req.body.website) return res.status(201).json({ success: true, message: 'Message received' });

  const data = pickFields(req.body, ['name', 'email', 'whatsapp', 'company', 'message']);

  // Optional attachments: the real type is checked from the file content, not the name
  const files = req.files || [];
  const checked = files.map((f) => ({ f, type: sniffDocumentType(f.buffer, f.originalname) }));
  if (checked.some((c) => !ATTACHMENT_TYPES.includes(c.type))) {
    throw ApiError.badRequest('Attachments must be PDF, JPG, PNG or WEBP files');
  }
  const stored = await Promise.all(
    checked.map(({ f, type }) =>
      StoredFile.create({ data: f.buffer, contentType: type, size: f.size, purpose: 'message/attachment', filename: (f.originalname || 'file').slice(0, 200) })
    )
  );
  const attachments = stored.map((s) => ({ file: s._id, name: s.filename, contentType: s.contentType, size: s.size }));

  let message;
  try {
    message = await Message.create({
      ...data,
      attachments,
      ip: req.ip,
      userAgent: req.get('user-agent')?.slice(0, 300),
    });
  } catch (err) {
    removeFiles(stored.map((s) => s._id));
    throw err;
  }
  queueMessage(message); // also create a lead in Odoo CRM (in the background)
  res.status(201).json({ success: true, message: 'Message received', data: { id: message.id } });
});

// ---------- Admin ----------

export const listMessages = asyncHandler(async (req, res) => {
  const { items, pagination } = await paginate(Message, req.query, {
    searchFields: ['name', 'email', 'company', 'message', 'whatsapp'],
    filterFields: ['status'],
    defaultSort: '-createdAt',
  });

  const grouped = await Message.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]);
  const counts = Object.fromEntries(MESSAGE_STATUSES.map((s) => [s, 0]));
  grouped.forEach((g) => {
    counts[g._id] = g.count;
  });

  res.json({ success: true, data: items, pagination, counts });
});

// Opening a message marks it as read
export const getMessage = asyncHandler(async (req, res) => {
  const message = await Message.findById(req.params.id).select('+ip +userAgent');
  if (!message) throw ApiError.notFound('Message not found');
  if (message.status === 'new') {
    message.status = 'read';
    message.readAt = new Date();
    await message.save();
  }
  res.json({ success: true, data: message });
});

export const updateMessage = asyncHandler(async (req, res) => {
  const message = await Message.findById(req.params.id);
  if (!message) throw ApiError.notFound('Message not found');
  const data = pickFields(req.body, ['status', 'notes']);
  if (data.status && data.status !== 'new' && !message.readAt) message.readAt = new Date();
  message.set(data);
  await message.save();
  res.json({ success: true, message: 'Message updated', data: message });
});

export const deleteMessage = asyncHandler(async (req, res) => {
  const message = await Message.findByIdAndDelete(req.params.id);
  if (!message) throw ApiError.notFound('Message not found');
  removeFiles(message.attachments.map((a) => a.file));
  res.json({ success: true, message: 'Message deleted', data: { id: message.id } });
});

// Body: { ids: [...], action: 'read' | 'archived' | 'delete' | ... }
export const bulkMessages = asyncHandler(async (req, res) => {
  const { ids, action } = req.body;
  if (!Array.isArray(ids) || !ids.length) throw ApiError.badRequest('Select at least one message');

  if (action === 'delete') {
    const withFiles = await Message.find({ _id: { $in: ids } }).select('attachments');
    const result = await Message.deleteMany({ _id: { $in: ids } });
    removeFiles(withFiles.flatMap((m) => m.attachments.map((a) => a.file)));
    return res.json({ success: true, message: `${result.deletedCount} message(s) deleted` });
  }
  if (!MESSAGE_STATUSES.includes(action)) throw ApiError.badRequest('Invalid action');

  const update = { status: action };
  if (action !== 'new') update.readAt = new Date();
  const result = await Message.updateMany({ _id: { $in: ids } }, { $set: update });
  res.json({ success: true, message: `${result.modifiedCount} message(s) updated` });
});

// Admin only: streams one attachment (visitor files may hold private data, so they are not public)
export const getMessageAttachment = asyncHandler(async (req, res) => {
  const message = await Message.findById(req.params.id).select('attachments');
  const attachment = message?.attachments[Number(req.params.index)];
  const file = attachment ? await StoredFile.findById(attachment.file) : null;
  if (!file) throw ApiError.notFound('Attachment not found');

  const name = (attachment.name || file.filename || 'attachment').replace(/["\\\r\n]/g, '');
  const ascii = name.replace(/[^\x20-\x7e]/g, '_');
  res.set({
    'Content-Type': file.contentType,
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': `${req.query.download ? 'attachment' : 'inline'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
  });
  res.send(file.data);
});
