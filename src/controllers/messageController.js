import Message, { MESSAGE_STATUSES } from '../models/Message.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import { paginate } from '../utils/queryBuilder.js';
import { pickFields } from './crudFactory.js';

// ---------- Public ----------

export const submitMessage = asyncHandler(async (req, res) => {
  // Honeypot field: real users never fill it, bots usually do
  if (req.body.website) return res.status(201).json({ success: true, message: 'Message received' });

  const data = pickFields(req.body, ['name', 'email', 'whatsapp', 'company', 'message']);
  const message = await Message.create({
    ...data,
    ip: req.ip,
    userAgent: req.get('user-agent')?.slice(0, 300),
  });
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
  res.json({ success: true, message: 'Message deleted', data: { id: message.id } });
});

// Body: { ids: [...], action: 'read' | 'archived' | 'delete' | ... }
export const bulkMessages = asyncHandler(async (req, res) => {
  const { ids, action } = req.body;
  if (!Array.isArray(ids) || !ids.length) throw ApiError.badRequest('Select at least one message');

  if (action === 'delete') {
    const result = await Message.deleteMany({ _id: { $in: ids } });
    return res.json({ success: true, message: `${result.deletedCount} message(s) deleted` });
  }
  if (!MESSAGE_STATUSES.includes(action)) throw ApiError.badRequest('Invalid action');

  const update = { status: action };
  if (action !== 'new') update.readAt = new Date();
  const result = await Message.updateMany({ _id: { $in: ids } }, { $set: update });
  res.json({ success: true, message: `${result.modifiedCount} message(s) updated` });
});
