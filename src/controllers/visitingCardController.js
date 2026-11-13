import VisitingCard from '../models/VisitingCard.js';
import asyncHandler from '../utils/asyncHandler.js';
import { pickFields } from './crudFactory.js';

const FIELDS = ['name', 'designation', 'company', 'email', 'phone', 'website', 'location', 'locationUrl'];

// Fields the public website needs (no audit info)
const toPublic = (card) => {
  const { updatedBy, createdAt, ...rest } = card.toJSON();
  return rest;
};

export const getPublicCard = asyncHandler(async (req, res) => {
  const card = await VisitingCard.getSingleton();
  res.json({ success: true, data: toPublic(card) });
});

export const getCard = asyncHandler(async (req, res) => {
  const card = await VisitingCard.getSingleton();
  await card.populate('updatedBy', 'name');
  res.json({ success: true, data: card });
});

// Superadmin only
export const updateCard = asyncHandler(async (req, res) => {
  const card = await VisitingCard.getSingleton();
  card.set(pickFields(req.body, FIELDS));
  card.updatedBy = req.admin._id;
  await card.save();
  await card.populate('updatedBy', 'name');
  res.json({ success: true, message: 'Visiting card updated', data: card });
});
