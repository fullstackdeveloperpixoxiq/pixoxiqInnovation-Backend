/**
 * Seeds the database.
 *   npm run seed           -> creates the first superadmin + website content (only into empty collections)
 *   npm run seed:fresh     -> wipes vacancies/services/certificates and re-imports them
 *   node src/seed/seed.js --demo -> also adds sample messages & applications (for testing charts)
 */
import mongoose from 'mongoose';
import env from '../config/env.js';
import connectDB from '../config/db.js';
import Admin from '../models/Admin.js';
import Vacancy from '../models/Vacancy.js';
import Service from '../models/Service.js';
import Certificate from '../models/Certificate.js';
import Message from '../models/Message.js';
import Application from '../models/Application.js';
import { vacancies, services, certificates } from './seedData.js';

const args = process.argv.slice(2);
const fresh = args.includes('--fresh');
const demo = args.includes('--demo');

const withOrder = (items) => items.map((item, order) => ({ ...item, order }));

const seedCollection = async (Model, items, label) => {
  if (fresh) await Model.deleteMany({});
  const count = await Model.countDocuments();
  if (count) {
    console.log(`• ${label}: ${count} already exist, skipped (use --fresh to replace)`);
    return;
  }
  await Model.insertMany(withOrder(items));
  console.log(`✔ ${label}: inserted ${items.length}`);
};

const seedAdmin = async () => {
  const { name, email, password } = env.seedAdmin;
  const existing = await Admin.findOne({ email: email.toLowerCase() });
  if (existing) {
    console.log(`• Admin ${email} already exists, skipped`);
    return;
  }
  await Admin.create({ name, email, password, role: 'superadmin' });
  console.log(`✔ Superadmin created: ${email} / ${password}  ← change this password after first login!`);
};

const randomDate = (daysBack) => new Date(Date.now() - Math.random() * daysBack * 24 * 60 * 60 * 1000);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

const seedDemo = async () => {
  const names = ['Arjun Nair', 'Priya Menon', 'Rahul Das', 'Sneha Pillai', 'Vivek Kumar', 'Anjali Raj', 'Mohammed Fasil', 'Divya Thomas'];
  const companies = ['TechNova', 'Smart Homes Ltd', 'Volt Systems', '', 'GreenGrid', 'Kerala Electronics'];
  const topics = [
    'We need OEM manufacturing for 10k smart plugs. Please share a quote.',
    'Looking for an ODM partner for a wearable fitness band.',
    'Interested in IoT product development for agricultural sensors.',
    'Can you help with PCB design and prototyping for our controller?',
    'Need industrial design and packaging for a new speaker.',
  ];

  const messages = Array.from({ length: 40 }, () => {
    const name = pick(names);
    return {
      name,
      email: `${name.split(' ')[0].toLowerCase()}${Math.floor(Math.random() * 99)}@example.com`,
      whatsapp: `+91 9${Math.floor(100000000 + Math.random() * 899999999)}`,
      company: pick(companies),
      message: pick(topics),
      status: pick(['new', 'new', 'read', 'replied', 'archived']),
      createdAt: randomDate(170),
    };
  });
  await Message.insertMany(messages);

  const openVacancies = await Vacancy.find();
  const applications = Array.from({ length: 35 }, () => {
    const name = pick(names);
    const vacancy = pick(openVacancies);
    return {
      name,
      email: `${name.split(' ')[0].toLowerCase()}.${Math.floor(Math.random() * 99)}@example.com`,
      phone: `+91 9${Math.floor(100000000 + Math.random() * 899999999)}`,
      resumeUrl: 'https://drive.google.com/file/d/example/view',
      position: vacancy?.title || 'Open Application',
      vacancy: vacancy?._id,
      experience: pick(['0-1 years', '1-3 years', '3-5 years', '5-10 years']),
      status: pick(['new', 'reviewing', 'shortlisted', 'interview', 'hired', 'rejected']),
      createdAt: randomDate(170),
    };
  });
  await Application.insertMany(applications);
  console.log(`✔ Demo data: ${messages.length} messages, ${applications.length} applications`);
};

const run = async () => {
  await connectDB();
  await seedAdmin();
  await seedCollection(Vacancy, vacancies, 'Vacancies');
  await seedCollection(Service, services, 'Services');
  await seedCollection(Certificate, certificates, 'Certificates');
  if (demo) await seedDemo();
  await mongoose.disconnect();
  console.log('Done.');
};

run().catch(async (err) => {
  console.error('Seed failed:', err);
  await mongoose.disconnect();
  process.exit(1);
});
