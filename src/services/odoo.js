import env from '../config/env.js';

// Minimal Odoo API client.
// Uses the JSON-2 API (Odoo 19+, API key as bearer token). If the server does not have it
// (older Odoo), falls back to the classic /jsonrpc API, which also needs ODOO_USERNAME.

const TIMEOUT_MS = 20000;
let mode = null; // 'json2' | 'jsonrpc', detected on the first call
let legacyUid = null;

export const isOdooEnabled = () => Boolean(env.odoo.url && env.odoo.db && env.odoo.apiKey);

const NETWORK_RETRIES = 3;
const RETRYABLE = ['UND_ERR_CONNECT_TIMEOUT', 'ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', 'UND_ERR_SOCKET', 'TimeoutError'];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

const postOnce = async (path, body, headers = {}) => {
  let res;
  try {
    res = await fetch(`${env.odoo.url}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    // Network-level failure: show the real reason (DNS, TLS, timeout...) instead of "fetch failed"
    const cause = err.cause?.code || err.cause?.message || err.name;
    const host = (() => {
      try {
        return new URL(env.odoo.url).host;
      } catch {
        return `invalid ODOO_URL (must start with https://)`;
      }
    })();
    const error = new Error(`Cannot reach Odoo at ${host}: ${cause}`);
    error.code = cause;
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

// Odoo answers with JSON, or with an HTML error page whose <p> holds the explanation
const errorText = (data) => {
  if (typeof data === 'object' && data) return String(data.message || data.name || JSON.stringify(data)).slice(0, 300);
  const html = String(data);
  const detail = html.match(/<p>([\s\S]*?)<\/p>/i)?.[1] || html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || html;
  return detail.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 300);
};

const callJson2 = async (model, method, params) => {
  const res = await post(`/json/2/${model}/${method}`, params, {
    Authorization: `bearer ${env.odoo.apiKey}`,
    'X-Odoo-Database': env.odoo.db,
  });
  if (res.status === 404 && mode === null) return { notSupported: true };
  if (!res.ok) throw new Error(`Odoo ${model}.${method} failed (${res.status}): ${errorText(res.data)}`);
  return { result: res.data };
};

const jsonRpc = async (service, method, args) => {
  const res = await post('/jsonrpc', { jsonrpc: '2.0', method: 'call', params: { service, method, args }, id: Date.now() });
  if (!res.ok) throw new Error(`Odoo jsonrpc failed (${res.status})`);
  if (res.data?.error) throw new Error(`Odoo: ${res.data.error.data?.message || res.data.error.message}`);
  return res.data.result;
};

const callLegacy = async (model, method, params) => {
  if (!env.odoo.username) {
    throw new Error('This Odoo version has no JSON-2 API. Set ODOO_USERNAME (the API user’s login email) in .env');
  }
  if (!legacyUid) {
    legacyUid = await jsonRpc('common', 'authenticate', [env.odoo.db, env.odoo.username, env.odoo.apiKey, {}]);
    if (!legacyUid) throw new Error('Odoo login failed: check ODOO_DB, ODOO_USERNAME and ODOO_API_KEY');
  }
  return jsonRpc('object', 'execute_kw', [env.odoo.db, legacyUid, env.odoo.apiKey, model, method, [], params]);
};

/**
 * Calls a method on an Odoo model with named arguments, e.g.
 * odooCall('crm.lead', 'create', { vals_list: [{ name: 'Hi' }] })
 */
export const odooCall = async (model, method, params = {}) => {
  if (!isOdooEnabled()) throw new Error('Odoo is not configured (ODOO_URL, ODOO_DB, ODOO_API_KEY)');
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
const fieldCache = new Map();
export const odooFields = async (model) => {
  if (!fieldCache.has(model)) {
    const fields = await odooCall(model, 'fields_get', { attributes: ['type'] });
    fieldCache.set(model, new Set(Object.keys(fields || {})));
  }
  return fieldCache.get(model);
};

export const odooApiMode = () => mode;
