import env from '../config/env.js';
import OdooConfig from '../models/OdooConfig.js';
import { decryptSecret } from '../ai/crypto.js';

// Minimal Odoo API client.
// Uses the JSON-2 API (Odoo 19+, API key as bearer token). If the server does not have it
// (older Odoo), falls back to the classic /jsonrpc API, which also needs a username.
//
// Connection: the settings saved by a superadmin in the admin panel (API key encrypted in the
// database) when present, otherwise the ODOO_* environment variables.

const TIMEOUT_MS = 20000;
const NETWORK_RETRIES = 3;
const RETRYABLE = ['UND_ERR_CONNECT_TIMEOUT', 'ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', 'UND_ERR_SOCKET', 'TimeoutError'];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Only the origin is used, so a pasted browser address like https://x.odoo.com/odoo/... works */
export const normalizeOdooUrl = (raw) => {
  const value = String(raw || '').trim();
  if (!value) return '';
  try {
    return new URL(value).origin;
  } catch {
    return value.replace(/\/+$/, '');
  }
};

/** Error raised by Odoo itself (HTTP status kept so callers can tell access errors from outages) */
export class OdooError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// Odoo answers with JSON, or with an HTML error page whose <p> holds the explanation
const errorText = (data) => {
  if (typeof data === 'object' && data) return String(data.message || data.name || JSON.stringify(data)).slice(0, 300);
  const html = String(data);
  const detail = html.match(/<p>([\s\S]*?)<\/p>/i)?.[1] || html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || html;
  return detail.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 300);
};

/**
 * Client for one connection { url, db, apiKey, username }.
 * The API mode (json2 / jsonrpc) and field lists are detected once and cached per client.
 */
export const createOdooClient = (conn) => {
  let mode = null;
  let legacyUid = null;
  const fieldCache = new Map();
  const enabled = Boolean(conn.url && conn.db && conn.apiKey);

  const postOnce = async (path, body, headers = {}) => {
    let res;
    try {
      res = await fetch(`${conn.url}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      // Network-level failure: show the real reason (DNS, TLS, timeout...) instead of "fetch failed"
      const cause = err.cause?.code || err.cause?.message || err.name;
      let host;
      try {
        host = new URL(conn.url).host;
      } catch {
        host = 'an invalid Odoo URL (must start with https://)';
      }
      const error = new Error(`Cannot reach Odoo at ${host}: ${cause}`);
      error.code = cause;
      error.network = true;
      throw error;
    }
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    return { status: res.status, ok: res.ok, data };
  };

  // Slow or flaky connections to Odoo are retried a few times before giving up
  const post = async (path, body, headers = {}, attempt = 1) => {
    try {
      return await postOnce(path, body, headers);
    } catch (err) {
      if (attempt < NETWORK_RETRIES && RETRYABLE.includes(err.code)) {
        await wait(2000 * attempt);
        return post(path, body, headers, attempt + 1);
      }
      throw err;
    }
  };

  const callJson2 = async (model, method, params) => {
    const res = await post(`/json/2/${model}/${method}`, params, {
      Authorization: `bearer ${conn.apiKey}`,
      'X-Odoo-Database': conn.db,
    });
    if (res.status === 404 && mode === null && /not ?found/i.test(errorText(res.data)) && !/model/i.test(errorText(res.data))) {
      return { notSupported: true };
    }
    if (!res.ok) throw new OdooError(`Odoo ${model}.${method} failed (${res.status}): ${errorText(res.data)}`, { status: res.status });
    return { result: res.data };
  };

  const jsonRpc = async (service, method, args) => {
    const res = await post('/jsonrpc', { jsonrpc: '2.0', method: 'call', params: { service, method, args }, id: Date.now() });
    if (!res.ok) throw new OdooError(`Odoo jsonrpc failed (${res.status})`, { status: res.status });
    if (res.data?.error) throw new OdooError(`Odoo: ${res.data.error.data?.message || res.data.error.message}`, { status: 400 });
    return res.data.result;
  };

  const callLegacy = async (model, method, params) => {
    if (!conn.username) {
      throw new OdooError('This Odoo version has no JSON-2 API. Enter the API user’s login email (username).', { status: 400 });
    }
    if (!legacyUid) {
      legacyUid = await jsonRpc('common', 'authenticate', [conn.db, conn.username, conn.apiKey, {}]);
      if (!legacyUid) throw new OdooError('Odoo login failed: check the database, username and API key', { status: 401 });
    }
    return jsonRpc('object', 'execute_kw', [conn.db, legacyUid, conn.apiKey, model, method, [], params]);
  };

  /** Calls a method with named arguments, e.g. call('crm.lead', 'create', { vals_list: [{ name: 'Hi' }] }) */
  const call = async (model, method, params = {}) => {
    if (!enabled) throw new OdooError('Odoo is not configured (URL, database and API key)', { status: 400, code: 'not_configured' });
    if (mode !== 'jsonrpc') {
      const out = await callJson2(model, method, params);
      if (!out.notSupported) {
        mode = 'json2';
        return out.result;
      }
      mode = 'jsonrpc';
    }
    return callLegacy(model, method, params);
  };

  // Field names differ between Odoo versions, so check which ones exist (cached per model)
  const fields = async (model) => {
    if (!fieldCache.has(model)) {
      const result = await call(model, 'fields_get', { attributes: ['type'] });
      fieldCache.set(model, new Set(Object.keys(result || {})));
    }
    return fieldCache.get(model);
  };

  /** Public server version, e.g. "19.0+e" (no credentials needed) */
  const version = async () => {
    const res = await post('/web/webclient/version_info', { jsonrpc: '2.0', method: 'call', params: {} });
    return res.data?.result?.server_version || '';
  };

  return { conn, enabled, call, fields, version, mode: () => mode };
};

// ---------- Active connection ----------

const fromEnv = () => ({ url: env.odoo.url, db: env.odoo.db, apiKey: env.odoo.apiKey, username: env.odoo.username, source: 'env' });
let client = createOdooClient(fromEnv());
let settings = { recruitmentEnabled: false, defaultJobId: null, defaultJobName: '', sourceName: 'PIXOXIQ AI Assistant' };

/**
 * (Re)loads the connection from the admin settings, falling back to ODOO_* env variables.
 * Called at startup and whenever a superadmin saves the Odoo settings.
 */
export const loadOdooConnection = async () => {
  const doc = await OdooConfig.getSingleton({ withSecrets: true });
  let conn = fromEnv();
  if (doc.apiKeyEnc && doc.url && doc.db) {
    try {
      conn = { url: normalizeOdooUrl(doc.url), db: doc.db, apiKey: decryptSecret(doc.apiKeyEnc), username: doc.username, source: 'database' };
    } catch (err) {
      console.error('[odoo] saved credentials cannot be decrypted, using environment settings:', err.message);
    }
  }
  client = createOdooClient(conn);
  settings = {
    recruitmentEnabled: Boolean(doc.recruitmentEnabled),
    defaultJobId: doc.defaultJobId ?? null,
    defaultJobName: doc.defaultJobName || '',
    sourceName: doc.sourceName || 'PIXOXIQ AI Assistant',
  };
  return { source: conn.source, enabled: client.enabled };
};

export const isOdooEnabled = () => client.enabled;
export const odooCall = (model, method, params) => client.call(model, method, params);
export const odooFields = (model) => client.fields(model);
export const odooApiMode = () => client.mode();
export const odooConnectionSource = () => client.conn.source;
export const odooBaseUrl = () => client.conn.url || '';
export const odooRecruitmentSettings = () => settings;
export const isRecruitmentSyncEnabled = () => client.enabled && settings.recruitmentEnabled;

/** Backend link to a record in Odoo (opens in the Odoo web client) */
export const odooRecordUrl = (model, id) => (client.conn.url && id ? `${client.conn.url}/odoo/${model}/${id}` : null);

// Rights needed by the Recruitment integration (minimum: no delete, no admin rights)
const REQUIRED_ACCESS = [
  ['hr.applicant', 'create'],
  ['hr.applicant', 'write'],
  ['hr.applicant', 'read'],
  ['hr.job', 'read'],
  ['ir.attachment', 'create'],
];

const hasAccess = async (c, model, operation) => {
  try {
    return Boolean(await c.call(model, 'has_access', { operation })); // Odoo 18+
  } catch {
    return Boolean(await c.call(model, 'check_access_rights', { operation, raise_exception: false })); // Odoo <= 17
  }
};

/**
 * Connection test: authentication, version, and access to the Recruitment models.
 * Uses `conn` when given (settings not saved yet), otherwise the active connection.
 */
export const testOdooConnection = async (conn) => {
  const c = conn ? createOdooClient({ ...conn, url: normalizeOdooUrl(conn.url) }) : client;
  const report = { ok: false, version: '', apiMode: '', access: {}, fields: {}, jobs: 0, message: '' };
  if (!c.enabled) {
    report.message = 'Enter the Odoo URL, database and API key.';
    return report;
  }
  try {
    report.version = await c.version().catch(() => '');
    await c.call('res.users', 'search_count', { domain: [] }); // authentication
    report.apiMode = c.mode();
    for (const [model, op] of REQUIRED_ACCESS) {
      try {
        report.access[`${model}.${op}`] = await hasAccess(c, model, op);
      } catch (err) {
        report.access[`${model}.${op}`] = false;
        report.fields[model] = err.message.slice(0, 200);
      }
    }
    const applicant = await c.fields('hr.applicant');
    report.fields['hr.applicant'] = ['partner_name', 'email_from', 'partner_phone', 'job_id', 'applicant_notes', 'linkedin_profile', 'source_id'].filter((f) =>
      applicant.has(f)
    );
    report.jobs = await c.call('hr.job', 'search_count', { domain: [] });
    const missing = Object.entries(report.access).filter(([, ok]) => !ok).map(([k]) => k);
    report.ok = missing.length === 0;
    report.message = report.ok
      ? `Connected to Odoo ${report.version || ''} (${report.apiMode}). Recruitment access OK, ${report.jobs} job position(s).`.replace(/\s+/g, ' ')
      : `Connected, but the API user is missing these rights: ${missing.join(', ')}`;
  } catch (err) {
    report.message = err.message.slice(0, 500);
  }
  return report;
};
