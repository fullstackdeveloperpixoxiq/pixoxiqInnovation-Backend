// Integration tests for the AI assistant's daily question quotas.
//
// Runs the real Express app against a throwaway MongoDB and a fake OpenAI-compatible AI
// server (the "custom" provider), so requests go through the same middleware, controller,
// quota service and provider adapter as in production.
//
//   npm test
//
// Starts its own `mongod` on a random port in a temp folder (set MONGOD_PATH if it is not on
// PATH), or uses TEST_MONGO_URI when set. It never touches the database configured in .env.

import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createFakeOdoo } from './fakeOdoo.js';

// ---------- Environment (must be set before the app is imported) ----------

const freePort = () =>
  new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });

const findMongod = () => {
  if (process.env.MONGOD_PATH) return process.env.MONGOD_PATH;
  if (process.platform === 'win32') {
    const root = 'C:\\Program Files\\MongoDB\\Server';
    if (fs.existsSync(root)) {
      const versions = fs.readdirSync(root).sort().reverse();
      for (const v of versions) {
        const exe = path.join(root, v, 'bin', 'mongod.exe');
        if (fs.existsSync(exe)) return exe;
      }
    }
  }
  return 'mongod';
};

let mongodProc = null;
let mongoDir = null;
let mongoUri = process.env.TEST_MONGO_URI;
if (!mongoUri) {
  const port = await freePort();
  mongoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxq-quota-test-'));
  mongodProc = spawn(findMongod(), ['--dbpath', mongoDir, '--port', String(port), '--bind_ip', '127.0.0.1', '--quiet'], {
    stdio: 'ignore',
  });
  mongoUri = `mongodb://127.0.0.1:${port}/pxq_quota_test`;
}

// Fake Odoo 19 (JSON-2 API) for the Recruitment integration; never a real Odoo
const ODOO_KEY = 'test-odoo-api-key-0000';
const fakeOdoo = createFakeOdoo({ apiKey: ODOO_KEY, db: 'pixoxiq-test' });
const odooPort = await freePort();
await new Promise((r) => fakeOdoo.server.listen(odooPort, '127.0.0.1', r));
process.env.ODOO_URL = `http://127.0.0.1:${odooPort}`;
process.env.ODOO_DB = 'pixoxiq-test';
process.env.ODOO_API_KEY = ODOO_KEY;
process.env.AI_ENCRYPTION_KEY = '11'.repeat(32);

process.env.MONGO_URI = mongoUri;
process.env.JWT_SECRET = 'test-secret-for-quota-tests-only-0123456789';
process.env.NODE_ENV = 'test';
// The per-minute burst limiters are covered separately; keep them out of the way here
process.env.CHAT_RATE_LIMIT_PER_MINUTE = '100000';
process.env.CHAT_IDENTITY_RATE_LIMIT_PER_MINUTE = '100000';
process.env.CHAT_SESSIONS_PER_HOUR = '100000';
process.env.CHAT_OTP_REQUESTS_PER_15_MIN = '100000';

const { default: mongoose } = await import('mongoose');
const { default: jwt } = await import('jsonwebtoken');
const { default: app } = await import('../src/app.js');
const { default: ChatSettings } = await import('../src/models/ChatSettings.js');
const { default: AiConfig } = await import('../src/models/AiConfig.js');
const { default: ChatUsage } = await import('../src/models/ChatUsage.js');
const { default: User } = await import('../src/models/User.js');
const { invalidateChatSettings } = await import('../src/ai/chatService.js');
const { invalidateAiConfig } = await import('../src/ai/configService.js');
const { setQuotaClock, quotaDay } = await import('../src/ai/quotaService.js');
const { setOtpDelivery } = await import('../src/ai/chatAccess.js');
const { default: ChatEnquiry } = await import('../src/models/ChatEnquiry.js');
const { default: ChatMessage } = await import('../src/models/ChatMessage.js');
const { default: ChatConversation } = await import('../src/models/ChatConversation.js');
const { backfillQueryTypes } = await import('../src/ai/queryBackfill.js');
const { default: Vacancy } = await import('../src/models/Vacancy.js');
const { ChatOtpChallenge, ChatVerifiedSession } = await import('../src/models/ChatVerification.js');
const { default: OdooConfig } = await import('../src/models/OdooConfig.js');
const { default: ChatEnquirySyncLog } = await import('../src/models/ChatEnquirySyncLog.js');
const { default: StoredFile } = await import('../src/models/StoredFile.js');
const { loadOdooConnection } = await import('../src/services/odoo.js');
const { runRecruitmentSyncOnce } = await import('../src/services/recruitmentSync.js');

// Verification emails are captured instead of sent
const sentCodes = [];
setOtpDelivery(async ({ email, otp }) => {
  sentCodes.push({ email, otp });
});

// ---------- Fake AI provider ----------

const ai = { mode: 'ok', calls: 0, classifierCalls: 0, delayMs: 0 };

const aiServer = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => {
    raw += c;
  });
  req.on('end', async () => {
    ai.calls += 1;
    if (ai.delayMs) await new Promise((r) => setTimeout(r, ai.delayMs));
    if (ai.mode === 'fail') {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'upstream exploded' } }));
      return;
    }
    const body = JSON.parse(raw || '{}');
    const system = body.messages?.find((m) => m.role === 'system')?.content || '';

    // Intent classifier call: this fake decides from the latest visitor line (the real
    // classifier is the configured model)
    if (system.includes('intent classifier')) {
      ai.classifierCalls += 1;
      const prompt = body.messages.at(-1).content;
      const latest = prompt.split('\n').filter((l) => l.startsWith('Visitor: ')).at(-1) || '';
      const topic = /servic/i.test(latest) ? 'services' : /office|located|contact/i.test(latest) ? 'contact' : /technolog/i.test(latest) ? 'technology' : /capital|weather|planet/i.test(latest) ? 'general' : 'other';
      let verdict = { category: 'WEBSITE_ENQUIRY', confidence: 0.95, vacancy: '', clarification: '', topic };
      if (/openings\?$/i.test(latest)) verdict = { category: 'AMBIGUOUS', confidence: 0.4, vacancy: '', clarification: 'Do you mean job openings or project availability?' };
      else if (/job|vacanc|career|intern|resume|salary/i.test(latest)) {
        verdict = { category: 'JOB_ENQUIRY', confidence: 0.93, vacancy: /react/i.test(latest) ? 'React Developer' : '', clarification: '', topic: 'recruitment' };
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(verdict) }, finish_reason: 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 10 } }));
      return;
    }
    // Candidate detail extraction: only from what the visitor wrote
    if (system.includes('extract job-candidate details')) {
      const text = body.messages.at(-1).content;
      const position = /react/i.test(text) ? 'React Developer' : /node/i.test(text) ? 'Node Developer' : '';
      const details = {
        name: text.match(/my name is ([A-Z][a-z]+(?: [A-Z][a-z]+)+)/)?.[1] || '',
        phone: text.match(/(\+91[\d ]{10,})/)?.[1]?.trim() || '',
        position,
        message: position ? `Wants to apply for the ${position} role` : '',
        skills: text.match(/skills: ([^.\n]+)/i)?.[1] || '',
        experience: text.match(/(\d+ years?)/)?.[1] || '',
        qualification: '',
        location: '',
        linkedin: '',
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(details) }, finish_reason: 'stop' }] }));
      return;
    }
    // Marks answers that were given recruitment data, so tests can check who gets it
    const withJobs = system.includes('Open positions at PIXOXIQ') ? ' [vacancies]' : '';
    const restricted = system.includes('Access rule: this visitor is NOT logged in') ? ' [restricted]' : '';
    const usage = { prompt_tokens: 120, completion_tokens: 30 };
    if (body.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Hello ' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `from PIXOXIQ.${withJobs}${restricted}` }, finish_reason: 'stop' }], usage })}\n\n`);
      res.end('data: [DONE]\n\n');
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: `Hello from PIXOXIQ.${withJobs}${restricted}` }, finish_reason: 'stop' }], usage }));
    }
  });
});

// ---------- Test browser (cookie jar + session token + optional login) ----------

let baseUrl;
const CHAT = () => `${baseUrl}/api/public/chat`;

class Browser {
  constructor() {
    this.cookie = null;
    this.session = null;
    this.token = null;
  }

  storeCookie(res) {
    const set = res.headers.getSetCookie?.() || [];
    const vid = set.find((c) => c.startsWith('pxq_vid='));
    if (vid) this.cookie = vid.split(';')[0];
  }

  headers(extra = {}) {
    return {
      'Content-Type': 'application/json',
      ...(this.session ? { 'X-Chat-Session': this.session } : {}),
      ...(this.cookie ? { Cookie: this.cookie } : {}),
      ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      ...extra,
    };
  }

  async open() {
    const res = await fetch(`${CHAT()}/session`, { method: 'POST', headers: this.headers(), body: '{}' });
    assert.equal(res.status, 201);
    this.storeCookie(res);
    this.session = (await res.json()).data.token;
    return this;
  }

  async request(pathname, init = {}) {
    const res = await fetch(`${CHAT()}${pathname}`, { ...init, headers: this.headers(init.headers) });
    this.storeCookie(res);
    return res;
  }

  /** Non-streaming question. Returns { status, body } */
  async ask(message = 'What services does PIXOXIQ offer?', extra = {}) {
    const res = await this.request('/messages?stream=0', { method: 'POST', body: JSON.stringify({ message, ...extra }) });
    return { status: res.status, body: await res.json() };
  }

  async usage() {
    const res = await this.request('/usage');
    assert.equal(res.status, 200);
    return (await res.json()).data;
  }
}

const newVisitor = () => new Browser().open();

let userSeq = 0;
const loginAs = async (browser) => {
  userSeq += 1;
  const user = await User.create({
    name: `Test User ${userSeq}`,
    email: `quota-user-${userSeq}-${Date.now()}@example.com`,
    phone: '+91 98765 43210',
    password: 'password123',
  });
  browser.token = jwt.sign({ id: user._id, type: 'user' }, process.env.JWT_SECRET, { expiresIn: '1h' });
  return user;
};

const setLimits = async (patch) => {
  await ChatSettings.updateOne({ key: 'default' }, { $set: patch });
  invalidateChatSettings();
};

const DEFAULT_LIMITS = { visitorDailyQuestionLimit: 10, userDailyQuestionLimit: 100, visitorIpDailyLimit: 0 };

// ---------- Lifecycle ----------

let server;

before(async () => {
  await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 30000 });
  await mongoose.connection.dropDatabase();

  await new Promise((r) => aiServer.listen(0, '127.0.0.1', r));
  const aiUrl = `http://127.0.0.1:${aiServer.address().port}/v1`;

  await ChatSettings.create({ key: 'default', enabled: true, ...DEFAULT_LIMITS });
  await AiConfig.create({ key: 'default', chat: { provider: 'custom', model: 'fake-model', baseUrl: aiUrl } });
  invalidateChatSettings();
  invalidateAiConfig();
  await Vacancy.create({ title: 'React Developer', department: 'Engineering', description: 'Build web apps with React.', isActive: true });
  await Vacancy.create({ title: 'Node Developer', department: 'Engineering', description: 'Build APIs with Node.js.', isActive: true });
  await OdooConfig.create({ key: 'default', recruitmentEnabled: true });
  await loadOdooConnection();

  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(async () => {
  ai.mode = 'ok';
  ai.delayMs = 0;
  setQuotaClock(null);
  await ChatUsage.deleteMany({});
  await ChatEnquiry.deleteMany({});
  await ChatOtpChallenge.deleteMany({});
  await ChatVerifiedSession.deleteMany({});
  sentCodes.length = 0;
  fakeOdoo.state.mode = 'ok';
  fakeOdoo.state.applicants.length = 0;
  fakeOdoo.state.attachments.length = 0;
  fakeOdoo.state.messages.length = 0;
  fakeOdoo.state.calls.length = 0;
  await ChatEnquirySyncLog.deleteMany({});
  await OdooConfig.updateOne({ key: 'default' }, { $set: { recruitmentEnabled: true, defaultJobId: null } });
  await loadOdooConnection();
  await setLimits(DEFAULT_LIMITS);
});

after(async () => {
  setQuotaClock(null);
  await new Promise((r) => server?.close(r));
  await new Promise((r) => aiServer.close(r));
  await new Promise((r) => fakeOdoo.server.close(r));
  await mongoose.disconnect();
  if (mongodProc) {
    mongodProc.kill();
    await new Promise((r) => setTimeout(r, 500));
    fs.rmSync(mongoDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

// ---------- Tests ----------

describe('visitor quota', () => {
  test('a visitor can ask exactly 10 questions; the 11th is rejected with 429', async () => {
    const browser = await newVisitor();
    for (let i = 1; i <= 10; i += 1) {
      const { status, body } = await browser.ask();
      assert.equal(status, 200, `question ${i}`);
      assert.match(body.answer, /^Hello from PIXOXIQ\./);
      assert.deepEqual(
        { limit: body.usage.limit, used: body.usage.used, remaining: body.usage.remaining, authenticated: body.usage.authenticated },
        { limit: 10, used: i, remaining: 10 - i, authenticated: false }
      );
    }
    const callsBefore = ai.calls;
    const { status, body } = await browser.ask();
    assert.equal(status, 429);
    assert.equal(body.code, 'quota_exceeded');
    assert.match(body.message, /100 questions per day/);
    assert.equal(body.usage.remaining, 0);
    assert.equal(body.usage.used, 10);
    assert.equal(ai.calls, callsBefore, 'the AI provider is not called for a rejected question');
  });

  test('refreshing the page (same cookie + session) does not reset usage', async () => {
    const browser = await newVisitor();
    for (let i = 0; i < 4; i += 1) assert.equal((await browser.ask()).status, 200);

    // A page reload: the browser keeps its cookie and localStorage session token
    const reloaded = Object.assign(new Browser(), { cookie: browser.cookie, session: browser.session });
    const usage = await reloaded.usage();
    assert.equal(usage.used, 4);
    assert.equal(usage.remaining, 6);
  });

  test('clearing only the session token or only the cookie keeps the quota', async () => {
    const browser = await newVisitor();
    for (let i = 0; i < 10; i += 1) assert.equal((await browser.ask()).status, 200);

    const freshSession = Object.assign(new Browser(), { cookie: browser.cookie });
    await freshSession.open(); // new localStorage token, same cookie
    assert.equal(freshSession.cookie, browser.cookie);
    assert.equal((await freshSession.ask()).status, 429);

    const noCookie = Object.assign(new Browser(), { session: browser.session }); // cookie deleted
    assert.equal((await noCookie.ask()).status, 429);
    assert.notEqual(noCookie.cookie, browser.cookie, 'a new cookie is issued');
  });

  test('a forged visitor cookie is ignored and replaced', async () => {
    const browser = await newVisitor();
    browser.cookie = 'pxq_vid=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.forged-signature';
    await browser.usage();
    assert.ok(browser.cookie && !browser.cookie.includes('forged'));
  });

  test('the per-network ceiling stops visitors who keep clearing all browser storage', async () => {
    await setLimits({ visitorIpDailyLimit: 25 });
    let accepted = 0;
    for (let b = 0; b < 3; b += 1) {
      const browser = await newVisitor(); // brand-new cookie + session each time
      for (let i = 0; i < 10; i += 1) if ((await browser.ask()).status === 200) accepted += 1;
    }
    assert.equal(accepted, 25);
    const blocked = await (await newVisitor()).ask();
    assert.equal(blocked.status, 429);
    assert.match(blocked.body.message, /network/);
  });
});

describe('logged-in user quota', () => {
  test('a logged-in user can ask exactly 100 questions; the 101st is rejected', async () => {
    const browser = await newVisitor();
    await loginAs(browser);
    for (let i = 1; i <= 100; i += 1) {
      const { status, body } = await browser.ask();
      assert.equal(status, 200, `question ${i}`);
      assert.equal(body.usage.remaining, 100 - i);
      assert.equal(body.usage.authenticated, true);
    }
    const { status, body } = await browser.ask();
    assert.equal(status, 429);
    assert.equal(body.code, 'quota_exceeded');
    assert.deepEqual([body.usage.limit, body.usage.used, body.usage.remaining], [100, 100, 0]);
  });

  test('the user id comes from the verified token, not from the request', async () => {
    const browser = await newVisitor();
    browser.token = jwt.sign({ id: new mongoose.Types.ObjectId(), type: 'user' }, 'wrong-secret');
    const usage = await browser.usage();
    assert.equal(usage.authenticated, false, 'an invalid token is treated as a visitor');
    assert.equal(usage.limit, 10);
  });

  test('logging in carries over visitor usage, and logging out does not reset it', async () => {
    const browser = await newVisitor();
    for (let i = 0; i < 10; i += 1) assert.equal((await browser.ask()).status, 200);
    assert.equal((await browser.ask()).status, 429);

    await loginAs(browser);
    const loggedIn = await browser.usage();
    assert.deepEqual([loggedIn.limit, loggedIn.used, loggedIn.remaining], [100, 10, 90]);
    // Asking again does not add the carried-over questions a second time
    const { body } = await browser.ask();
    assert.equal(body.usage.used, 11);
    assert.equal((await browser.usage()).used, 11);

    browser.token = null; // logout
    const loggedOut = await browser.usage();
    assert.equal(loggedOut.remaining, 0);
    assert.equal((await browser.ask()).status, 429);
  });
});

describe('daily reset at midnight IST', () => {
  test('quotas reset at 00:00 Asia/Kolkata, not at UTC midnight', async () => {
    // 2026-03-10 23:59:30 IST == 18:29:30 UTC
    setQuotaClock(() => new Date('2026-03-10T18:29:30Z'));
    const browser = await newVisitor();
    for (let i = 0; i < 10; i += 1) assert.equal((await browser.ask()).status, 200);
    const { status, body } = await browser.ask();
    assert.equal(status, 429);
    assert.equal(body.usage.resetsAt, '2026-03-10T18:30:00.000Z'); // 2026-03-11 00:00 IST

    // 2026-03-11 00:00:05 IST
    setQuotaClock(() => new Date('2026-03-10T18:30:05Z'));
    const next = await browser.ask();
    assert.equal(next.status, 200);
    assert.equal(next.body.usage.used, 1);

    // UTC midnight (05:30 IST) is not a reset
    setQuotaClock(() => new Date('2026-03-11T00:00:05Z'));
    assert.equal((await browser.usage()).used, 1);
  });

  test('quotaDay handles the IST day boundary', () => {
    assert.equal(quotaDay(new Date('2026-12-31T18:29:59Z')).day, '2026-12-31');
    assert.equal(quotaDay(new Date('2026-12-31T18:30:00Z')).day, '2027-01-01');
    assert.equal(quotaDay(new Date('2026-12-31T18:30:00Z')).resetsAt.toISOString(), '2027-01-01T18:30:00.000Z');
  });
});

describe('concurrency', () => {
  test('parallel visitor requests cannot exceed the limit', async () => {
    ai.delayMs = 30;
    const browser = await newVisitor();
    const results = await Promise.all(Array.from({ length: 30 }, () => browser.ask()));
    const ok = results.filter((r) => r.status === 200).length;
    const rejected = results.filter((r) => r.status === 429).length;
    assert.equal(ok, 10);
    assert.equal(rejected, 20);
    const usage = await browser.usage();
    assert.equal(usage.used, 10);
    assert.equal(await ChatUsage.countDocuments({ subjectType: 'visitor' }), 1, 'no duplicate daily records');
  });

  test('parallel logged-in requests cannot exceed the limit', async () => {
    ai.delayMs = 20;
    const browser = await newVisitor();
    await loginAs(browser);
    const results = await Promise.all(Array.from({ length: 130 }, () => browser.ask()));
    assert.equal(results.filter((r) => r.status === 200).length, 100);
    assert.equal(results.filter((r) => r.status === 429).length, 30);
    assert.equal(await ChatUsage.countDocuments({ subjectType: 'user' }), 1);
  });
});

describe('what does not count', () => {
  test('failed AI requests are refunded', async () => {
    const browser = await newVisitor();
    assert.equal((await browser.ask()).status, 200);

    ai.mode = 'fail';
    const failed = await browser.ask();
    assert.equal(failed.status, 503);
    assert.equal(failed.body.usage.used, 1, 'the failed question was refunded');

    ai.mode = 'ok';
    assert.equal((await browser.usage()).used, 1);
    const primary = await ChatUsage.findOne({ isPrimary: true }).lean();
    assert.equal(primary.failed, 1);
    assert.equal(primary.answered, 1);
    assert.equal(primary.inputTokens, 120);
  });

  test('failed streaming requests are refunded too', async () => {
    const browser = await newVisitor();
    ai.mode = 'fail';
    const res = await browser.request('/messages', { method: 'POST', body: JSON.stringify({ message: 'Hello?' }) });
    const text = await res.text();
    assert.match(text, /event: usage/);
    assert.match(text, /event: error/);
    assert.equal((await browser.usage()).used, 0);
  });

  test('empty, too long and invalid requests are not counted', async () => {
    const browser = await newVisitor();
    assert.equal((await browser.ask('   ')).status, 400);
    assert.equal((await browser.ask('x'.repeat(5000))).status, 400);
    assert.equal((await browser.ask('Hi', { conversationId: new mongoose.Types.ObjectId().toString() })).status, 404);
    assert.equal((await browser.ask('Hi', { conversationId: 'not-an-id' })).status, 404);
    const noSession = await fetch(`${CHAT()}/messages?stream=0`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Hi' }),
    });
    assert.equal(noSession.status, 401);
    assert.equal((await browser.usage()).used, 0);
    assert.equal(await ChatUsage.countDocuments({ used: { $gt: 0 } }), 0);
  });
});

describe('admin analytics', () => {
  test('GET /api/ai/quota reports today without double counting carried-over questions', async () => {
    const { default: Admin } = await import('../src/models/Admin.js');
    const admin = await Admin.create({ name: 'Quota Admin', email: `admin-${Date.now()}@example.com`, password: 'password123', role: 'admin' });
    await setLimits({ inputTokenPricePerMillion: 1, outputTokenPricePerMillion: 2 });

    const browser = await newVisitor();
    for (let i = 0; i < 3; i += 1) await browser.ask();
    await loginAs(browser);
    for (let i = 0; i < 2; i += 1) await browser.ask(); // 3 carried over + 2 own
    ai.mode = 'fail';
    await browser.ask();
    ai.mode = 'ok';

    const res = await fetch(`${baseUrl}/api/ai/quota?days=7`, { headers: { Authorization: `Bearer ${admin.generateToken()}` } });
    assert.equal(res.status, 200);
    const { data } = await res.json();
    assert.equal(data.todayTotals.questions, 5);
    assert.equal(data.todayTotals.visitorQuestions, 3);
    assert.equal(data.todayTotals.userQuestions, 2);
    assert.equal(data.todayTotals.activeUsers, 1);
    assert.equal(data.todayTotals.failed, 1);
    assert.equal(data.todayTotals.inputTokens, 5 * 120);
    assert.equal(data.todayTotals.estimatedCost, Math.round(((600 / 1e6) * 1 + (150 / 1e6) * 2) * 10000) / 10000);
    assert.equal(data.daily.length, 7);
    assert.equal(data.daily.at(-1).questions, 5);
    assert.deepEqual(data.limits, { visitor: 10, user: 100, visitorIp: 0 });
    const top = data.topUsers.find((u) => u.type === 'user');
    assert.equal(top.questions, 2);
    assert.ok(top.email.includes('@example.com'));
    const visitor = data.topUsers.find((u) => u.type === 'visitor');
    assert.equal(visitor.questions, 3);
    assert.match(visitor.id, /^[0-9a-f]{8}$/, 'visitors are only shown by a short tag');
  });
});

describe('streaming responses', () => {
  test('usage is sent as soon as the question is accepted and with the answer', async () => {
    const browser = await newVisitor();
    const res = await browser.request('/messages', { method: 'POST', body: JSON.stringify({ message: 'Hello?' }) });
    const text = await res.text();
    const events = text
      .split('\n\n')
      .filter((b) => b.startsWith('event:'))
      .map((b) => ({ event: b.match(/^event: (\w+)/)[1], data: JSON.parse(b.split('\ndata: ')[1]) }));
    assert.deepEqual(
      events.map((e) => e.event).filter((e) => e !== 'delta'),
      ['meta', 'usage', 'intent', 'sources', 'done']
    );
    assert.equal(events.find((e) => e.event === 'usage').data.remaining, 9);
    assert.equal(events.find((e) => e.event === 'done').data.usage.used, 1);
  });
});

// ---------- Enquiry classification, job-enquiry access and admin management ----------

const SERVICES_Q = 'What services does PIXOXIQ offer?';
const COMPANY_Q = 'Where is the PIXOXIQ office located?';
const JOB_Q = 'Do you have any job vacancies for a React developer?';

const verifyEmail = async (browser, email = `guest-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`) => {
  const req = await browser.request('/verification/request', { method: 'POST', body: JSON.stringify({ email }) });
  assert.equal(req.status, 202);
  const { otp } = sentCodes.at(-1);
  const res = await browser.request('/verification/confirm', { method: 'POST', body: JSON.stringify({ email, otp }) });
  assert.equal(res.status, 200);
  return email;
};

const regenerate = async (browser, conversationId) => {
  const res = await browser.request(`/conversations/${conversationId}/regenerate?stream=0`, { method: 'POST' });
  return { status: res.status, body: await res.json() };
};

let adminToken;
const admin = async (pathname, init = {}) => {
  if (!adminToken) {
    const { default: Admin } = await import('../src/models/Admin.js');
    const a = await Admin.create({ name: 'Enquiry Admin', email: `enq-admin-${Date.now()}@example.com`, password: 'password123', role: 'admin' });
    adminToken = a.generateToken();
  }
  const res = await fetch(`${baseUrl}/api/ai${pathname}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}`, ...init.headers },
  });
  return { status: res.status, body: await res.json() };
};

describe('enquiry classification and job-enquiry access', () => {
  test('1-2. anonymous visitors can ask about services and company information', async () => {
    const browser = await newVisitor();
    for (const q of [SERVICES_Q, COMPANY_Q]) {
      const { status, body } = await browser.ask(q);
      assert.equal(status, 200);
      assert.equal(body.intent.category, 'WEBSITE_ENQUIRY');
      assert.ok(body.intent.confidence >= 0.9);
      assert.doesNotMatch(body.answer, /\[vacancies\]/, 'no recruitment data for anonymous visitors');
    }
  });

  test('3. anonymous vacancy question requires verification, keeps the message and does not use a question', async () => {
    const browser = await newVisitor();
    const { status, body } = await browser.ask(JOB_Q);
    assert.equal(status, 403);
    assert.equal(body.code, 'verification_required');
    assert.equal(body.message, 'To help you with career-related questions, please log in or verify your email address.');
    assert.equal(body.intent.category, 'JOB_ENQUIRY');
    assert.equal(body.usage.used, 0, 'the withheld question is refunded');

    const conv = await (await browser.request(`/conversations/${body.conversation.id}`)).json();
    assert.equal(conv.data.messages.length, 1);
    assert.equal(conv.data.messages[0].awaitingVerification, true);
    assert.equal(await ChatEnquiry.countDocuments(), 0);
  });

  test('4. after email OTP verification the same conversation continues with real vacancy data', async () => {
    const browser = await newVisitor();
    const blocked = await browser.ask(JOB_Q);
    assert.equal(blocked.status, 403);
    const email = await verifyEmail(browser);

    const status = await (await browser.request('/verification')).json();
    assert.deepEqual(status.data, { verified: true, method: 'email', email });

    const resumed = await regenerate(browser, blocked.body.conversation.id);
    assert.equal(resumed.status, 200);
    assert.match(resumed.body.answer, /\[vacancies\]/);
    assert.doesNotMatch(resumed.body.answer, /\[restricted\]/);
    assert.equal(resumed.body.usage.limit, 10, 'verification does not grant a bigger quota');
    assert.equal(resumed.body.usage.used, 1);

    const followUp = await browser.ask('What is the salary for that role?', { conversationId: blocked.body.conversation.id });
    assert.equal(followUp.status, 200);

    const enquiries = await ChatEnquiry.find().lean();
    assert.equal(enquiries.length, 1, 'one record per conversation');
    assert.equal(enquiries[0].type, 'job');
    assert.equal(enquiries[0].authType, 'email_verified');
    assert.equal(enquiries[0].email, email);
    assert.equal(enquiries[0].user, null, 'a verified guest is not a registered user');
    assert.equal(enquiries[0].questionCount, 2);
    assert.equal(enquiries[0].vacancyTitle, 'React Developer');
  });

  test('5-6. registered users can ask about jobs and website topics; only the job enquiry is a record', async () => {
    const browser = await newVisitor();
    const user = await loginAs(browser);
    const job = await browser.ask(JOB_Q);
    assert.equal(job.status, 200);
    assert.match(job.body.answer, /\[vacancies\]/);
    const site = await browser.ask(SERVICES_Q);
    assert.equal(site.status, 200);

    const enquiries = await ChatEnquiry.find().lean();
    assert.deepEqual(enquiries.map((e) => [e.type, e.authType, String(e.user)]), [['job', 'registered', String(user._id)]]);
    assert.equal(enquiries[0].email, user.email);
    // The general question is kept on its conversation (no duplicate record)
    const general = await ChatConversation.findById(site.body.data.conversation.id).lean();
    assert.equal(general.queryType, 'general');
    assert.equal(general.topic, 'services');
  });

  test('7. switching from website to job questions in one conversation enforces verification', async () => {
    const browser = await newVisitor();
    const first = await browser.ask(SERVICES_Q);
    assert.equal(first.status, 200);
    const conversationId = first.body.data.conversation.id;
    const switched = await browser.ask('Great. Are you hiring interns?', { conversationId });
    assert.equal(switched.status, 403);
    assert.equal(switched.body.code, 'verification_required');
    // Back to a website topic: allowed again
    const back = await browser.ask('And what technologies do you use?', { conversationId });
    assert.equal(back.status, 200);
  });

  test('ambiguous questions get a clarifying question', async () => {
    const browser = await newVisitor();
    const { status, body } = await browser.ask('Do you have any openings?');
    assert.equal(status, 200);
    assert.equal(body.intent.category, 'AMBIGUOUS');
    assert.equal(body.answer, 'Do you mean job openings or project availability?');
    assert.equal(await ChatEnquiry.countDocuments(), 0);
  });

  test('8. anonymous visitors never become identifiable enquiries', async () => {
    const browser = await newVisitor();
    await browser.ask(SERVICES_Q);
    await browser.request('/messages?stream=0', {
      method: 'POST',
      headers: { 'X-Chat-Email': 'someone@example.com' },
      body: JSON.stringify({ message: COMPANY_Q }),
    });
    await browser.ask(JOB_Q);
    assert.equal(await ChatEnquiry.countDocuments(), 0);
  });

  test('12. direct API requests cannot bypass verification', async () => {
    const browser = await newVisitor();
    // A client-supplied classification or flag is ignored
    const forged = await browser.ask(JOB_Q, { intent: 'WEBSITE_ENQUIRY', verified: true, category: 'WEBSITE_ENQUIRY' });
    assert.equal(forged.status, 403);
    // Regenerating the withheld question is checked again
    const regen = await regenerate(browser, forged.body.conversation.id);
    assert.equal(regen.status, 403);
    // The streaming endpoint is gated the same way (no answer is streamed)
    const streamed = await browser.request('/messages', { method: 'POST', body: JSON.stringify({ message: JOB_Q }) });
    assert.equal(streamed.status, 403);
    // Another session cannot reuse a verification
    const verified = await newVisitor();
    await verifyEmail(verified);
    const stranger = await newVisitor();
    assert.equal((await stranger.ask(JOB_Q)).status, 403);
    // Revoking verification removes access
    assert.equal((await verified.ask(JOB_Q)).status, 200);
    await verified.request('/verification', { method: 'DELETE' });
    assert.equal((await verified.ask(JOB_Q)).status, 403);
  });

  test('OTP codes are hashed, limited and expire', async () => {
    const browser = await newVisitor();
    const email = 'otp-limits@example.com';
    assert.equal((await browser.request('/verification/request', { method: 'POST', body: JSON.stringify({ email }) })).status, 202);
    const { otp } = sentCodes.at(-1);
    const stored = await ChatOtpChallenge.findOne({ email }).lean();
    assert.notEqual(stored.otpHash, otp);
    assert.match(stored.otpHash, /^[0-9a-f]{64}$/);

    // Resend cooldown
    assert.equal((await browser.request('/verification/request', { method: 'POST', body: JSON.stringify({ email }) })).status, 429);

    // Wrong codes: 5 attempts, then locked even for the right code
    const wrong = otp === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i += 1) {
      const r = await browser.request('/verification/confirm', { method: 'POST', body: JSON.stringify({ email, otp: wrong }) });
      assert.equal(r.status, 400);
    }
    const locked = await browser.request('/verification/confirm', { method: 'POST', body: JSON.stringify({ email, otp }) });
    assert.equal(locked.status, 429);

    // Expired code
    await ChatOtpChallenge.updateOne({ email }, { attempts: 0, otpExpiresAt: new Date(Date.now() - 1000) });
    const expired = await browser.request('/verification/confirm', { method: 'POST', body: JSON.stringify({ email, otp }) });
    assert.equal(expired.status, 400);
    assert.equal(await ChatVerifiedSession.countDocuments(), 0);
  });
});

describe('admin enquiries', () => {
  test('9-11. verified job and registered website enquiries appear in their tabs; admins view and update them', async () => {
    const guest = await newVisitor();
    const blocked = await guest.ask(JOB_Q);
    const email = await verifyEmail(guest);
    await regenerate(guest, blocked.body.conversation.id);

    const member = await newVisitor();
    const user = await loginAs(member);
    await member.ask(SERVICES_Q);

    await (await newVisitor()).ask(COMPANY_Q); // anonymous: not listed

    const jobs = await admin('/job-queries');
    assert.equal(jobs.status, 200);
    assert.equal(jobs.body.data.length, 1);
    assert.equal(jobs.body.data[0].email, email);
    assert.equal(jobs.body.data[0].authType, 'email_verified');
    assert.equal(jobs.body.data[0].vacancy.title, 'React Developer');
    assert.equal(jobs.body.counts.new, 1);

    const mineList = await admin(`/general-queries?auth=authenticated&search=${encodeURIComponent(user.name)}`);
    assert.equal(mineList.body.data.length, 1);
    assert.equal(mineList.body.data[0].user.name, user.name);
    const anon = (await admin('/general-queries?auth=anonymous')).body.data[0];
    assert.equal(anon.user, null);
    assert.match(anon.visitorTag, /^[0-9a-f]{8}$/);

    const detail = await admin(`/job-queries/${jobs.body.data[0].id}`);
    assert.equal(detail.status, 200);
    assert.deepEqual(detail.body.data.messages.map((m) => m.role), ['user', 'assistant']);
    assert.equal(detail.body.data.messages[0].intent, 'JOB_ENQUIRY');

    for (const status of ['in_progress', 'resolved', 'new']) {
      const updated = await admin(`/job-queries/${jobs.body.data[0].id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) });
      assert.equal(updated.status, 200);
      assert.equal(updated.body.data.status, status);
    }
    const invalid = await admin(`/job-queries/${jobs.body.data[0].id}/status`, { method: 'PATCH', body: JSON.stringify({ status: 'deleted' }) });
    assert.equal(invalid.status, 400);

    assert.equal((await admin(`/job-queries?search=${encodeURIComponent(email.slice(0, 8))}`)).body.data.length, 1);
    assert.equal((await admin('/job-queries?status=resolved')).body.data.length, 0);
    assert.equal((await admin('/job-queries?from=2000-01-01&to=2000-01-02')).body.data.length, 0);

    const stats = await admin('/job-queries/stats');
    assert.equal(stats.body.data.totals.all, 1);
    assert.equal(stats.body.data.totals.new, 1);
    assert.equal(stats.body.data.pendingSync, 0);
    assert.equal(stats.body.data.uniqueUsers, 1);
    assert.equal(stats.body.data.uniqueVerifiedGuests, 1);
    assert.equal(stats.body.data.daily.length, 30);
    assert.equal(stats.body.data.daily.at(-1).job, 1);
    assert.equal(stats.body.data.monthly.length, 12);

    // Admin APIs need an admin token (a website user token is not enough)
    const asUser = await fetch(`${baseUrl}/api/ai/job-queries`, { headers: { Authorization: `Bearer ${member.token}` } });
    assert.equal(asUser.status, 401);

    // Deleting the conversation removes its enquiry
    await guest.request(`/conversations/${blocked.body.conversation.id}`, { method: 'DELETE' });
    assert.equal(await ChatEnquiry.countDocuments({ type: 'job' }), 0);
    assert.equal(await ChatMessage.countDocuments({ conversation: blocked.body.conversation.id }), 0);
  });
});

// ---------- Odoo Recruitment integration ----------

const waitFor = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw new Error('waitFor timed out');
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 25));
  }
};

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

const getApplication = async (browser, conversationId) => {
  const res = await browser.request(`/conversations/${conversationId}/application`);
  return { status: res.status, body: await res.json() };
};

const submit = async (browser, conversationId, fields, resume) => {
  const form = new FormData();
  Object.entries(fields).forEach(([k, v]) => form.append(k, v));
  if (resume) form.append('resume', new Blob([resume.data], { type: resume.type }), resume.name);
  const headers = browser.headers();
  delete headers['Content-Type']; // multipart boundary set by fetch
  const res = await fetch(`${CHAT()}/conversations/${conversationId}/application`, { method: 'POST', headers, body: form });
  browser.storeCookie(res);
  return { status: res.status, body: await res.json() };
};

const syncedEnquiry = (id) => waitFor(async () => {
  const e = await ChatEnquiry.findById(id).lean();
  return ['synced', 'failed', 'requires_attention'].includes(e.odoo.status) ? e : null;
});

describe('Odoo Recruitment: chatbot job enquiries', () => {
  test('1, 4, 5, 12. registered user: details mapped to Odoo with the right job; admin sees the applicant link', async () => {
    const browser = await newVisitor();
    const user = await loginAs(browser);
    const asked = await browser.ask('I have 4 years of React experience. Do you have a job for a React developer?');
    assert.equal(asked.status, 200);
    const conversationId = asked.body.data.conversation.id;

    const app = await getApplication(browser, conversationId);
    assert.equal(app.status, 200);
    const [draft] = app.body.data.applications;
    assert.equal(draft.status, 'draft');
    assert.equal(draft.candidate.name, user.name, 'account details are not asked again');
    assert.equal(draft.candidate.phone, user.phone);
    assert.equal(draft.candidate.position, 'React Developer');
    assert.equal(draft.candidate.experience, '4 years');
    assert.deepEqual(draft.missing, []);
    assert.equal(fakeOdoo.state.applicants.length, 0, 'nothing is sent before the candidate submits');

    // Consent is required
    assert.equal((await submit(browser, conversationId, { enquiryId: draft.id })).status, 400);

    const sent = await submit(browser, conversationId, { enquiryId: draft.id, consent: 'true', skills: 'React, TypeScript' });
    assert.equal(sent.status, 201);
    const enquiry = await syncedEnquiry(draft.id);
    assert.equal(enquiry.odoo.status, 'synced');

    assert.equal(fakeOdoo.state.applicants.length, 1);
    const applicant = fakeOdoo.state.applicants[0];
    assert.equal(applicant.id, enquiry.odoo.applicantId);
    assert.equal(applicant.partner_name, user.name);
    assert.equal(applicant.email_from, user.email);
    assert.equal(applicant.partner_phone, user.phone);
    assert.equal(applicant.job_id, 7, 'linked to the existing Odoo job of the vacancy');
    assert.match(applicant.applicant_notes, /React, TypeScript/);
    assert.match(applicant.applicant_notes, new RegExp(`PIXOXIQ-ENQ-${draft.id}`));
    assert.match(applicant.applicant_notes, /Registered PIXOXIQ account/);
    assert.ok(applicant.source_id, 'source "PIXOXIQ AI Assistant" set');
    assert.equal(fakeOdoo.state.sources[0].name, 'PIXOXIQ AI Assistant');

    const list = await admin('/job-queries?syncStatus=synced');
    assert.equal(list.body.data.length, 1);
    const item = list.body.data[0];
    assert.equal(item.odoo.applicantId, applicant.id);
    assert.equal(item.odoo.url, `${process.env.ODOO_URL}/odoo/hr.applicant/${applicant.id}`);
    assert.equal(item.position, 'React Developer');
    assert.equal(list.body.syncCounts.synced, 1);
    const vac = await Vacancy.findOne({ title: 'React Developer' }).lean();
    assert.equal((await admin(`/job-queries?vacancy=${vac._id}`)).body.data.length, 1);
    assert.equal((await admin('/job-queries?vacancy=general')).body.data.length, 0);
    assert.equal((await admin(`/job-queries?search=${encodeURIComponent(user.name)}`)).body.data.length, 1);
  });

  test('2, 6. OTP-verified guest: name collected in the chat, CV uploaded to the applicant and kept private', async () => {
    const browser = await newVisitor();
    const blocked = await browser.ask('Hi, my name is Priya Sharma. Any job openings for a React developer?');
    assert.equal(blocked.status, 403);
    await verifyEmail(browser, 'priya@example.com');
    const resumed = await regenerate(browser, blocked.body.conversation.id);
    assert.equal(resumed.status, 200);

    const [draft] = (await getApplication(browser, blocked.body.conversation.id)).body.data.applications;
    assert.equal(draft.authType, 'email_verified');
    assert.equal(draft.email, 'priya@example.com');
    assert.equal(draft.candidate.name, 'Priya Sharma');

    // Invalid CV type is rejected (content checked, not the name)
    const bad = await submit(browser, blocked.body.conversation.id, { enquiryId: draft.id, consent: 'true' }, { data: Buffer.from('MZ fake exe'), type: 'application/pdf', name: 'cv.pdf' });
    assert.equal(bad.status, 400);

    const sent = await submit(browser, blocked.body.conversation.id, { enquiryId: draft.id, consent: 'true', phone: '+91 91234 56789' }, { data: PDF, type: 'application/pdf', name: 'priya-cv.pdf' });
    assert.equal(sent.status, 201);
    assert.equal(sent.body.data.resume.name, 'priya-cv.pdf');
    const enquiry = await syncedEnquiry(draft.id);
    assert.equal(enquiry.odoo.status, 'synced');

    const applicant = fakeOdoo.state.applicants[0];
    assert.equal(applicant.partner_name, 'Priya Sharma');
    assert.equal(applicant.email_from, 'priya@example.com');
    assert.equal(applicant.partner_phone, '+91 91234 56789');
    assert.match(applicant.applicant_notes, /Email-verified guest/);
    assert.equal(fakeOdoo.state.attachments.length, 1);
    const attachment = fakeOdoo.state.attachments[0];
    assert.deepEqual([attachment.res_model, attachment.res_id, attachment.name, attachment.size], ['hr.applicant', applicant.id, 'priya-cv.pdf', PDF.length]);
    assert.equal(enquiry.odoo.attachmentId, attachment.id);

    // The CV is never public; admins download it through their own endpoint
    const fileId = String(enquiry.resume.file);
    assert.equal((await StoredFile.findById(fileId).lean()).purpose, 'chat-enquiry/resume');
    assert.equal((await fetch(`${baseUrl}/api/public/files/${fileId}`)).status, 404);
    const download = await fetch(`${baseUrl}/api/ai/job-queries/${draft.id}/resume`, { headers: { Authorization: `Bearer ${adminToken}` } });
    assert.equal(download.status, 200);
    assert.equal(Buffer.from(await download.arrayBuffer()).toString(), PDF.toString());
  });

  test('3. unverified visitors cannot read or submit a job application', async () => {
    const browser = await newVisitor();
    const blocked = await browser.ask(JOB_Q);
    assert.equal(blocked.status, 403);
    assert.equal((await getApplication(browser, blocked.body.conversation.id)).status, 403);
    const forged = await submit(browser, blocked.body.conversation.id, { enquiryId: new mongoose.Types.ObjectId().toString(), consent: 'true', name: 'X', position: 'Y', message: 'Z' });
    assert.equal(forged.status, 403);
    assert.equal(await ChatEnquiry.countDocuments(), 0);
    assert.equal(fakeOdoo.state.calls.length, 0, 'Odoo is never contacted');
  });

  test('7. repeated messages and resubmissions update the same applicant (no duplicates, crash-safe)', async () => {
    const browser = await newVisitor();
    await loginAs(browser);
    const first = await browser.ask('Do you have a job for a React developer?');
    const conversationId = first.body.data.conversation.id;
    const [draft] = (await getApplication(browser, conversationId)).body.data.applications;
    await submit(browser, conversationId, { enquiryId: draft.id, consent: 'true' });
    await syncedEnquiry(draft.id);

    // More messages about the same job in the same conversation
    await browser.ask('What is the salary for the React developer job?', { conversationId });
    await browser.ask('My skills: React, Redux. Is the React job remote?', { conversationId });
    assert.equal(await ChatEnquiry.countDocuments({ type: 'job' }), 1);

    // Candidate updates the application: the same applicant is written, not a new one
    const updated = await submit(browser, conversationId, { enquiryId: draft.id, consent: 'true', location: 'Bengaluru' });
    assert.equal(updated.status, 200);
    await waitFor(async () => (await ChatEnquiry.findById(draft.id).lean()).odoo.status === 'synced' && fakeOdoo.state.applicants[0]?.applicant_notes?.includes('Bengaluru'));
    assert.equal(fakeOdoo.state.applicants.length, 1);

    // Worker stopped after creating the applicant but before saving its id: the stable
    // reference in Odoo is found again instead of creating a second applicant
    await ChatEnquiry.updateOne({ _id: draft.id }, { $set: { 'odoo.applicantId': null, 'odoo.status': 'pending', 'odoo.nextRetryAt': new Date(0) } });
    await runRecruitmentSyncOnce();
    const relinked = await ChatEnquiry.findById(draft.id).lean();
    assert.equal(relinked.odoo.status, 'synced');
    assert.equal(relinked.odoo.applicantId, fakeOdoo.state.applicants[0].id);
    assert.equal(fakeOdoo.state.applicants.length, 1);
    const logs = await ChatEnquirySyncLog.find({ enquiry: draft.id }).sort({ createdAt: 1 }).lean();
    assert.deepEqual(logs.map((l) => l.outcome), ['created', 'updated', 'linked']);
  });

  test('a candidate who already applied for the same job in Odoo is linked, not duplicated', async () => {
    const browser = await newVisitor();
    const user = await loginAs(browser);
    fakeOdoo.state.applicants.push({ id: 55, partner_name: user.name, email_from: user.email.toUpperCase(), job_id: 7, applicant_notes: '<p>Website form</p>', active: true });
    const asked = await browser.ask('Do you have a job for a React developer?');
    const [draft] = (await getApplication(browser, asked.body.data.conversation.id)).body.data.applications;
    await submit(browser, asked.body.data.conversation.id, { enquiryId: draft.id, consent: 'true' });
    const enquiry = await syncedEnquiry(draft.id);
    assert.equal(enquiry.odoo.applicantId, 55);
    assert.equal(fakeOdoo.state.applicants.length, 1);
    assert.equal(fakeOdoo.state.applicants[0].applicant_notes, '<p>Website form</p>', 'their existing notes are not overwritten');
    assert.equal(fakeOdoo.state.messages.length, 1, 'the chatbot enquiry is added as a note');
  });

  test('8. the same candidate applying for a different vacancy gets a separate applicant', async () => {
    const browser = await newVisitor();
    await loginAs(browser);
    const react = await browser.ask('Do you have a job for a React developer?');
    const conversationId = react.body.data.conversation.id;
    const node = await browser.ask('I would also like the Node developer job.', { conversationId });
    assert.equal(node.status, 200);
    // The fake classifier only names React vacancies, so pick Node in the panel (as a candidate would)
    let apps = (await getApplication(browser, conversationId)).body.data.applications;
    assert.equal(apps.length, 1);
    await submit(browser, conversationId, { enquiryId: apps[0].id, consent: 'true' });
    await syncedEnquiry(apps[0].id);

    const other = await browser.ask('Do you have a job for a React developer in another team?');
    const otherConv = other.body.data.conversation.id;
    apps = (await getApplication(browser, otherConv)).body.data.applications;
    const nodeVacancy = (await getApplication(browser, otherConv)).body.data.vacancies.find((v) => v.title === 'Node Developer');
    const sent = await submit(browser, otherConv, { enquiryId: apps[0].id, consent: 'true', vacancyId: nodeVacancy.id });
    assert.equal(sent.status, 201);
    await syncedEnquiry(apps[0].id);

    assert.equal(fakeOdoo.state.applicants.length, 2);
    assert.deepEqual(fakeOdoo.state.applicants.map((a) => a.job_id).sort(), [7, 8]);
  });

  test('9, 10. Odoo down: the enquiry is kept, marked failed, and retried automatically with backoff', async () => {
    fakeOdoo.state.mode = 'down';
    const browser = await newVisitor();
    await loginAs(browser);
    const asked = await browser.ask('Do you have a job for a React developer?');
    const [draft] = (await getApplication(browser, asked.body.data.conversation.id)).body.data.applications;
    const sent = await submit(browser, asked.body.data.conversation.id, { enquiryId: draft.id, consent: 'true' });
    assert.equal(sent.status, 201, 'the candidate is not affected by the outage');

    const failed = await syncedEnquiry(draft.id);
    assert.equal(failed.odoo.status, 'failed');
    assert.equal(failed.odoo.attempts, 1);
    assert.match(failed.odoo.lastError, /503/);
    const delay = failed.odoo.nextRetryAt - failed.odoo.lastAttemptAt;
    assert.ok(delay >= 29000 && delay <= 31000, `first retry after ~30s (got ${delay})`);

    // Not due yet: the worker leaves it alone
    assert.equal(await runRecruitmentSyncOnce(), 0);

    // Second failure doubles the delay
    await ChatEnquiry.updateOne({ _id: draft.id }, { $set: { 'odoo.nextRetryAt': new Date(0) } });
    await runRecruitmentSyncOnce();
    const again = await ChatEnquiry.findById(draft.id).lean();
    assert.equal(again.odoo.attempts, 2);
    const delay2 = again.odoo.nextRetryAt - again.odoo.lastAttemptAt;
    assert.ok(delay2 >= 59000 && delay2 <= 61000, `second retry after ~60s (got ${delay2})`);

    // Odoo back: the next automatic run syncs it
    fakeOdoo.state.mode = 'ok';
    await ChatEnquiry.updateOne({ _id: draft.id }, { $set: { 'odoo.nextRetryAt': new Date(0) } });
    assert.equal(await runRecruitmentSyncOnce(), 1);
    const synced = await ChatEnquiry.findById(draft.id).lean();
    assert.equal(synced.odoo.status, 'synced');
    assert.equal(synced.odoo.lastError, '');
    assert.equal(fakeOdoo.state.applicants.length, 1);
    const logs = await ChatEnquirySyncLog.find({ enquiry: draft.id }).sort({ createdAt: 1 }).lean();
    assert.deepEqual(logs.map((l) => l.outcome), ['failed', 'failed', 'created']);
    assert.ok(logs.every((l) => !/test-odoo-api-key/.test(l.error)), 'credentials never logged');
  });

  test('11. admin retries manually; access errors need attention instead of endless retries', async () => {
    fakeOdoo.state.mode = 'denied';
    const browser = await newVisitor();
    await loginAs(browser);
    const asked = await browser.ask('Do you have a job for a React developer?');
    const [draft] = (await getApplication(browser, asked.body.data.conversation.id)).body.data.applications;
    await submit(browser, asked.body.data.conversation.id, { enquiryId: draft.id, consent: 'true' });
    const stuck = await syncedEnquiry(draft.id);
    assert.equal(stuck.odoo.status, 'requires_attention');
    assert.equal(stuck.odoo.nextRetryAt, null);
    assert.equal(await runRecruitmentSyncOnce(), 0, 'not retried automatically');

    fakeOdoo.state.mode = 'ok'; // admin fixed the Odoo access rights
    const retried = await admin(`/job-queries/${draft.id}/sync`, { method: 'POST' });
    assert.equal(retried.status, 200);
    assert.equal(retried.body.data.odoo.status, 'synced');
    assert.ok(retried.body.data.odoo.applicantId);

    const logs = await admin(`/job-queries/${draft.id}/sync-logs`);
    assert.equal(logs.body.data[0].trigger, 'manual');
    assert.equal(logs.body.data[0].outcome, 'created');
    assert.ok(logs.body.data[0].admin);
    assert.equal(logs.body.data[1].outcome, 'requires_attention');

    // Not submitted yet: cannot be synced
    const draftOnly = await newVisitor();
    await loginAs(draftOnly);
    const q = await draftOnly.ask('Do you have a job for a React developer?');
    const [unsent] = (await getApplication(draftOnly, q.body.data.conversation.id)).body.data.applications;
    assert.equal((await admin(`/job-queries/${unsent.id}/sync`, { method: 'POST' })).status, 400);
  });

  test('13. website enquiries are never sent to Odoo Recruitment', async () => {
    const browser = await newVisitor();
    await loginAs(browser);
    const asked = await browser.ask(SERVICES_Q);
    assert.equal(asked.status, 200);
    assert.equal(await ChatEnquiry.countDocuments(), 0, 'general questions create no enquiry record');
    const apps = await getApplication(browser, asked.body.data.conversation.id);
    assert.equal(apps.body.data.applications.length, 0);
    // Not even a job id from another type can be pushed through these endpoints
    const conversationId = asked.body.data.conversation.id;
    assert.equal((await submit(browser, conversationId, { enquiryId: conversationId, consent: 'true' })).status, 404);
    assert.equal((await admin(`/job-queries/${conversationId}/sync`, { method: 'POST' })).status, 404);
    await runRecruitmentSyncOnce();
    assert.equal(fakeOdoo.state.applicants.length, 0);
  });

  test('disabled integration keeps submitted enquiries pending until it is enabled', async () => {
    await OdooConfig.updateOne({ key: 'default' }, { $set: { recruitmentEnabled: false } });
    await loadOdooConnection();
    const browser = await newVisitor();
    await loginAs(browser);
    const asked = await browser.ask('Do you have a job for a React developer?');
    const [draft] = (await getApplication(browser, asked.body.data.conversation.id)).body.data.applications;
    await submit(browser, asked.body.data.conversation.id, { enquiryId: draft.id, consent: 'true' });
    const pending = await waitFor(async () => {
      const e = await ChatEnquiry.findById(draft.id).lean();
      return e.odoo.lastError ? e : null;
    });
    assert.equal(pending.odoo.status, 'pending');
    assert.equal(pending.odoo.attempts, 0);
    assert.equal(fakeOdoo.state.applicants.length, 0);
  });

  test('general career enquiries use the configured default job position', async () => {
    await OdooConfig.updateOne({ key: 'default' }, { $set: { defaultJobId: 9, defaultJobName: 'General Applications' } });
    await loadOdooConnection();
    const browser = await newVisitor();
    await loginAs(browser);
    const asked = await browser.ask('Are you hiring interns?');
    const [draft] = (await getApplication(browser, asked.body.data.conversation.id)).body.data.applications;
    assert.equal(draft.vacancy, null);
    const sent = await submit(browser, asked.body.data.conversation.id, { enquiryId: draft.id, consent: 'true', position: 'Internship', message: 'Looking for a 6-month internship' });
    assert.equal(sent.status, 201);
    await syncedEnquiry(draft.id);
    assert.equal(fakeOdoo.state.applicants[0].job_id, 9);
    assert.equal(fakeOdoo.state.jobs.length, 3, 'no job positions are created for general enquiries');
  });
});

describe('Odoo integration settings', () => {
  test('superadmins manage the connection; the API key is encrypted and never returned', async () => {
    const { default: Admin } = await import('../src/models/Admin.js');
    const superadmin = await Admin.create({ name: 'Super', email: `super-${Date.now()}@example.com`, password: 'password123', role: 'superadmin' });
    const token = superadmin.generateToken();
    const call = async (method, pathname, body, t = token) => {
      const res = await fetch(`${baseUrl}/api${pathname}`, {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
        body: body && JSON.stringify(body),
      });
      return { status: res.status, body: await res.json(), raw: res };
    };

    // Regular admins cannot see or change it
    await admin('/job-queries'); // creates the regular admin token
    assert.equal((await call('GET', '/odoo/config', undefined, adminToken)).status, 403);

    const saved = await call('PUT', '/odoo/config', { url: `${process.env.ODOO_URL}/odoo/action-123`, db: 'pixoxiq-test', apiKey: ODOO_KEY, recruitmentEnabled: true, defaultJobId: 9, defaultJobName: 'General Applications' });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.data.url, process.env.ODOO_URL, 'only the origin is kept');
    assert.equal(saved.body.data.activeSource, 'database');
    assert.equal(saved.body.data.apiKeyLast4, ODOO_KEY.slice(-4));
    assert.ok(!JSON.stringify(saved.body).includes(ODOO_KEY));
    const stored = await OdooConfig.findOne({ key: 'default' }).select('+apiKeyEnc').lean();
    assert.ok(stored.apiKeyEnc.startsWith('v1:'));
    assert.ok(!stored.apiKeyEnc.includes(ODOO_KEY));

    const test = await call('POST', '/odoo/config/test', {});
    assert.equal(test.status, 200);
    assert.equal(test.body.data.ok, true);
    assert.equal(test.body.data.version, '19.0+e');
    assert.equal(test.body.data.apiMode, 'json2');
    assert.equal(test.body.data.access['hr.applicant.create'], true);
    assert.ok(test.body.data.fields['hr.applicant'].includes('applicant_notes'));

    const wrongKey = await call('POST', '/odoo/config/test', { url: process.env.ODOO_URL, db: 'pixoxiq-test', apiKey: 'wrong-key' });
    assert.equal(wrongKey.body.data.ok, false);
    assert.match(wrongKey.body.data.message, /401/);

    const jobs = await call('GET', '/odoo/jobs');
    assert.deepEqual(jobs.body.data.map((j) => j.name), ['React Developer', 'Node Developer', 'General Applications']);

    assert.equal((await call('PUT', '/odoo/config', { url: 'http://odoo.example.com' })).status, 400, 'https required for remote hosts');
    const cfg = await call('GET', '/odoo/config');
    assert.ok(!JSON.stringify(cfg.body).includes(ODOO_KEY));

    // Back to the environment connection for other tests
    await OdooConfig.updateOne({ key: 'default' }, { $set: { apiKeyEnc: '', apiKeyLast4: '', url: '', db: '' } });
    await loadOdooConnection();
  });
});

// ---------- Job Queries vs Normal / General Queries ----------

const makeAdmin = async (role) => {
  const { default: Admin } = await import('../src/models/Admin.js');
  const a = await Admin.create({ name: `${role} user`, email: `${role}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`, password: 'password123', role });
  const token = a.generateToken();
  return async (pathname, init = {}) => {
    const res = await fetch(`${baseUrl}/api${pathname}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...init.headers },
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
};

describe('Job Queries and Normal / General Queries', () => {
  beforeEach(async () => {
    await ChatConversation.deleteMany({});
    await ChatMessage.deleteMany({});
  });

  test('1-3, 5. job enquiries only in Job Queries; company and random questions only in General; general never goes to Odoo', async () => {
    const member = await newVisitor();
    const user = await loginAs(member);
    const job = await member.ask('Do you have a job for a React developer?');
    const company = await member.ask(COMPANY_Q);
    const random = await (await newVisitor()).ask('What is the capital of France?');
    const small = await (await newVisitor()).ask('Hello there!');

    const jobs = await admin('/job-queries');
    assert.deepEqual(jobs.body.data.map((e) => e.conversationId), [job.body.data.conversation.id]);
    assert.equal(jobs.body.data[0].email, user.email);

    const general = await admin('/general-queries');
    const ids = general.body.data.map((c) => c.id).sort();
    assert.deepEqual(ids, [company.body.data.conversation.id, random.body.data.conversation.id, small.body.data.conversation.id].sort());
    assert.ok(!ids.includes(job.body.data.conversation.id));
    const byId = Object.fromEntries(general.body.data.map((c) => [c.id, c]));
    assert.equal(byId[company.body.data.conversation.id].topic, 'contact');
    assert.equal(byId[random.body.data.conversation.id].topic, 'general');
    assert.equal(byId[small.body.data.conversation.id].topic, 'other');

    assert.equal((await admin('/general-queries?topic=general')).body.data.length, 1);
    assert.equal((await admin('/general-queries?auth=authenticated')).body.data.length, 1);
    assert.equal((await admin('/general-queries?auth=anonymous')).body.data.length, 2);
    assert.equal((await admin(`/general-queries?search=${encodeURIComponent('capital of France')}`)).body.data.length, 1);
    assert.equal((await admin(`/general-queries?search=${encodeURIComponent(user.name)}`)).body.data.length, 1);
    assert.equal((await admin('/general-queries?from=2000-01-01&to=2000-01-02')).body.data.length, 0);

    // Conversation detail: questions and AI answers
    const detail = await admin(`/general-queries/${random.body.data.conversation.id}`);
    assert.deepEqual(detail.body.data.messages.map((m) => m.role), ['user', 'assistant']);
    assert.equal(detail.body.data.conversation.user, null);
    // A job conversation is not reachable through General (and vice versa)
    assert.equal((await admin(`/general-queries/${job.body.data.conversation.id}`)).status, 404);
    assert.equal((await admin(`/job-queries/${company.body.data.conversation.id}`)).status, 404);

    await runRecruitmentSyncOnce();
    assert.equal(fakeOdoo.state.applicants.length, 0, 'nothing was submitted, nothing sent');
  });

  test('4. job queries still sync to Odoo through the Job Queries API', async () => {
    const member = await newVisitor();
    await loginAs(member);
    const asked = await member.ask('Do you have a job for a React developer?');
    const [draft] = (await getApplication(member, asked.body.data.conversation.id)).body.data.applications;
    await submit(member, asked.body.data.conversation.id, { enquiryId: draft.id, consent: 'true' });
    const enquiry = await syncedEnquiry(draft.id);
    assert.equal(enquiry.odoo.status, 'synced');
    const list = await admin('/job-queries?syncStatus=synced');
    assert.equal(list.body.data[0].odoo.applicantId, fakeOdoo.state.applicants[0].id);
  });

  test('6. a conversation that turns into a job enquiry moves to Job Queries with its history', async () => {
    const member = await newVisitor();
    await loginAs(member);
    const first = await member.ask(SERVICES_Q);
    const conversationId = first.body.data.conversation.id;
    assert.equal((await admin('/general-queries')).body.data.length, 1);

    await member.ask('Great. Do you have a job for a React developer?', { conversationId });
    assert.equal((await admin('/general-queries')).body.data.length, 0);
    const [jobQuery] = (await admin('/job-queries')).body.data;
    assert.equal(jobQuery.conversationId, conversationId);
    const detail = await admin(`/job-queries/${jobQuery.id}`);
    assert.equal(detail.body.data.messages.length, 4, 'earlier general messages are kept');
    assert.equal(detail.body.data.messages[0].content, SERVICES_Q);

    // Ambiguous question: clarification, no reclassification
    const ambiguous = await member.ask('Do you have any openings?');
    assert.equal(ambiguous.body.intent.category, 'AMBIGUOUS');
    const conv = await ChatConversation.findById(ambiguous.body.data.conversation.id).lean();
    assert.equal(conv.queryType, 'general');
  });

  test('7. anonymous visitors cannot create identifiable job enquiries', async () => {
    const browser = await newVisitor();
    const res = await browser.request('/messages?stream=0', {
      method: 'POST',
      headers: { 'X-Chat-Email': 'someone@example.com' },
      body: JSON.stringify({ message: 'Do you have a job for a React developer?', category: 'WEBSITE_ENQUIRY', queryType: 'general' }),
    });
    assert.equal(res.status, 403);
    assert.equal(await ChatEnquiry.countDocuments(), 0);
    assert.equal((await admin('/job-queries')).body.data.length, 0);
    // Its conversation is marked as recruitment, so it does not show up as a general query either
    assert.equal((await admin('/general-queries')).body.data.length, 0);
  });

  test('8-9. HR sees Job Queries only; admins see both sections (enforced by the API)', async () => {
    const member = await newVisitor();
    await loginAs(member);
    await member.ask('Do you have a job for a React developer?');
    await member.ask(SERVICES_Q);

    const hr = await makeAdmin('hr');
    const hrJobs = await hr('/ai/job-queries');
    assert.equal(hrJobs.status, 200);
    assert.equal(hrJobs.body.data.length, 1);
    assert.equal((await hr('/ai/job-queries/stats')).status, 200);
    const id = hrJobs.body.data[0].id;
    assert.equal((await hr(`/ai/job-queries/${id}`)).status, 200);
    assert.equal((await hr(`/ai/job-queries/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status: 'in_progress' }) })).status, 200);
    assert.equal((await hr('/vacancies')).status, 200, 'vacancy names for the filter');
    assert.equal((await hr('/auth/me')).status, 200);

    for (const [method, path] of [
      ['GET', '/ai/general-queries'],
      ['GET', '/ai/general-queries/stats'],
      ['GET', '/ai/conversations'],
      ['GET', '/ai/settings'],
      ['GET', '/ai/usage'],
      ['GET', '/dashboard/stats'],
      ['GET', '/messages'],
      ['GET', '/applications'],
      ['GET', '/users'],
      ['GET', '/odoo/status'],
      ['POST', '/vacancies'],
      ['GET', '/auth/admins'],
    ]) {
      const r = await hr(path, { method, ...(method === 'POST' && { body: '{}' }) });
      assert.equal(r.status, 403, `${method} ${path} must be forbidden for HR`);
    }

    const adm = await makeAdmin('admin');
    assert.equal((await adm('/ai/job-queries')).status, 200);
    const general = await adm('/ai/general-queries');
    assert.equal(general.status, 200);
    assert.equal(general.body.data.length, 1);
    assert.equal((await adm('/ai/general-queries/stats')).status, 200);
  });

  test('archive, statistics and aggregate-only anonymous activity', async () => {
    const member = await newVisitor();
    await loginAs(member);
    const a = await member.ask(SERVICES_Q);
    await (await newVisitor()).ask('What is the capital of France?');
    await (await newVisitor()).ask(COMPANY_Q);
    await (await newVisitor()).ask('Do you have a job for a React developer?'); // anonymous job attempt

    const archived = await admin(`/general-queries/${a.body.data.conversation.id}/archive`, { method: 'PATCH', body: JSON.stringify({ archived: true }) });
    assert.equal(archived.status, 200);
    assert.equal(archived.body.data.status, 'archived');
    assert.equal((await admin('/general-queries')).body.data.length, 2, 'archived ones are hidden by default');
    assert.equal((await admin('/general-queries?status=archived')).body.data.length, 1);
    await admin(`/general-queries/${a.body.data.conversation.id}/archive`, { method: 'PATCH', body: JSON.stringify({ archived: false }) });
    assert.equal((await admin('/general-queries')).body.data.length, 3);

    const stats = (await admin('/general-queries/stats')).body.data;
    assert.equal(stats.total, 3);
    assert.equal(stats.authenticated, 1);
    assert.equal(stats.anonymous, 2);
    assert.deepEqual(stats.topics.map((t) => t.topic).sort(), ['contact', 'general', 'services']);
    assert.equal(stats.daily.length, 30);
    assert.equal(stats.daily.at(-1).authenticated + stats.daily.at(-1).anonymous, 3);
    assert.equal(stats.monthly.length, 12);
    assert.ok(!JSON.stringify(stats).includes('@'), 'no identities in statistics');

    const jobStats = (await admin('/job-queries/stats')).body.data;
    assert.equal(jobStats.totals.all, 0);
    assert.equal(jobStats.pendingSync, 0);
  });

  test('10. existing conversations are classified without losing anything', async () => {
    const member = await newVisitor();
    await loginAs(member);
    const job = await member.ask('Do you have a job for a React developer?');
    const general = await (await newVisitor()).ask(SERVICES_Q);
    const oldJob = await (await newVisitor()).ask(JOB_Q); // anonymous, blocked
    // Simulate records from before the split
    await ChatConversation.collection.updateMany({}, { $unset: { queryType: '', topic: '', adminStatus: '' } });
    const before = { conversations: await ChatConversation.countDocuments(), messages: await ChatMessage.countDocuments() };

    const result = await backfillQueryTypes();
    assert.deepEqual(result, { job: 2, general: 1 });
    const types = Object.fromEntries((await ChatConversation.find().lean()).map((c) => [String(c._id), c.queryType]));
    assert.equal(types[job.body.data.conversation.id], 'job');
    assert.equal(types[oldJob.body.conversation.id], 'job');
    assert.equal(types[general.body.data.conversation.id], 'general');
    assert.deepEqual({ conversations: await ChatConversation.countDocuments(), messages: await ChatMessage.countDocuments() }, before);
    assert.deepEqual(await backfillQueryTypes(), { job: 0, general: 0 }, 'idempotent');
  });
});
