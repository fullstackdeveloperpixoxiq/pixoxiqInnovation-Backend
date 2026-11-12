import Vacancy from '../models/Vacancy.js';
import Certificate from '../models/Certificate.js';
import Service from '../models/Service.js';
import Message from '../models/Message.js';
import Application from '../models/Application.js';
import asyncHandler from '../utils/asyncHandler.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Counts documents per month for the last `months` months, filling gaps with 0
const monthlyCounts = async (Model, since) => {
  const rows = await Model.aggregate([
    { $match: { createdAt: { $gte: since } } },
    { $group: { _id: { y: { $year: '$createdAt' }, m: { $month: '$createdAt' } }, count: { $sum: 1 } } },
  ]);
  return Object.fromEntries(rows.map((r) => [`${r._id.y}-${r._id.m}`, r.count]));
};

const dailyCounts = async (Model, since) => {
  const rows = await Model.aggregate([
    { $match: { createdAt: { $gte: since } } },
    { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, count: { $sum: 1 } } },
  ]);
  return Object.fromEntries(rows.map((r) => [r._id, r.count]));
};

const pctChange = (current, previous) => {
  if (!previous) return current ? 100 : 0;
  return Math.round(((current - previous) / previous) * 100);
};

export const getStats = asyncHandler(async (req, res) => {
  const now = new Date();
  const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 5, 1);
  const thirtyDaysAgo = new Date(now.getTime() - 29 * 24 * 60 * 60 * 1000);
  thirtyDaysAgo.setUTCHours(0, 0, 0, 0);
  const sixtyDaysAgo = new Date(thirtyDaysAgo.getTime() - 30 * 24 * 60 * 60 * 1000);

  const [
    vacancies,
    activeVacancies,
    certificates,
    services,
    messages,
    newMessages,
    applications,
    newApplications,
    messagesLast30,
    messagesPrev30,
    applicationsLast30,
    applicationsPrev30,
    msgMonthly,
    appMonthly,
    msgDaily,
    appDaily,
    appByStatus,
    msgByStatus,
    vacByDepartment,
    topPositions,
    recentMessages,
    recentApplications,
  ] = await Promise.all([
    Vacancy.countDocuments(),
    Vacancy.countDocuments({ isActive: true }),
    Certificate.countDocuments(),
    Service.countDocuments(),
    Message.countDocuments(),
    Message.countDocuments({ status: 'new' }),
    Application.countDocuments(),
    Application.countDocuments({ status: 'new' }),
    Message.countDocuments({ createdAt: { $gte: thirtyDaysAgo } }),
    Message.countDocuments({ createdAt: { $gte: sixtyDaysAgo, $lt: thirtyDaysAgo } }),
    Application.countDocuments({ createdAt: { $gte: thirtyDaysAgo } }),
    Application.countDocuments({ createdAt: { $gte: sixtyDaysAgo, $lt: thirtyDaysAgo } }),
    monthlyCounts(Message, sixMonthsAgo),
    monthlyCounts(Application, sixMonthsAgo),
    dailyCounts(Message, thirtyDaysAgo),
    dailyCounts(Application, thirtyDaysAgo),
    Application.aggregate([{ $group: { _id: '$status', value: { $sum: 1 } } }]),
    Message.aggregate([{ $group: { _id: '$status', value: { $sum: 1 } } }]),
    Vacancy.aggregate([
      { $group: { _id: '$department', total: { $sum: 1 }, active: { $sum: { $cond: ['$isActive', 1, 0] } } } },
      { $sort: { total: -1 } },
    ]),
    Application.aggregate([
      { $group: { _id: '$position', value: { $sum: 1 } } },
      { $sort: { value: -1 } },
      { $limit: 5 },
    ]),
    Message.find().sort('-createdAt').limit(5),
    Application.find().sort('-createdAt').limit(5),
  ]);

  const monthly = [];
  for (let i = 5; i >= 0; i -= 1) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${d.getMonth() + 1}`;
    monthly.push({ month: MONTHS[d.getMonth()], messages: msgMonthly[key] || 0, applications: appMonthly[key] || 0 });
  }

  const daily = [];
  for (let i = 0; i < 30; i += 1) {
    const d = new Date(thirtyDaysAgo.getTime() + i * 24 * 60 * 60 * 1000);
    const key = d.toISOString().slice(0, 10);
    daily.push({
      date: key,
      label: `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`,
      messages: msgDaily[key] || 0,
      applications: appDaily[key] || 0,
    });
  }

  res.json({
    success: true,
    data: {
      totals: {
        vacancies,
        activeVacancies,
        certificates,
        services,
        messages,
        newMessages,
        applications,
        newApplications,
      },
      trends: {
        messages: { current: messagesLast30, change: pctChange(messagesLast30, messagesPrev30) },
        applications: { current: applicationsLast30, change: pctChange(applicationsLast30, applicationsPrev30) },
      },
      charts: {
        monthly,
        daily,
        applicationsByStatus: appByStatus.map((s) => ({ name: s._id, value: s.value })),
        messagesByStatus: msgByStatus.map((s) => ({ name: s._id, value: s.value })),
        vacanciesByDepartment: vacByDepartment.map((d) => ({ name: d._id, total: d.total, active: d.active })),
        topPositions: topPositions.map((p) => ({ name: p._id, value: p.value })),
      },
      recent: { messages: recentMessages, applications: recentApplications },
    },
  });
});
