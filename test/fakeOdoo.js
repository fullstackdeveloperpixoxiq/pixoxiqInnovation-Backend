// Fake Odoo 19 server for integration tests: the JSON-2 API (/json/2/<model>/<method>) with
// the hr.applicant fields of a real Odoo 19 instance (no hr.candidate, no name/description).
// It never talks to a real Odoo.
import http from 'node:http';

export const createFakeOdoo = ({ apiKey, db }) => {
  const state = {
    mode: 'ok', // ok | down (HTTP 503) | denied (HTTP 403)
    calls: [],
    jobs: [
      { id: 7, name: 'React Developer', active: true },
      { id: 8, name: 'Node Developer', active: true },
      { id: 9, name: 'General Applications', active: true },
    ],
    applicants: [],
    attachments: [],
    sources: [],
    messages: [],
    nextId: 100,
  };

  const APPLICANT_FIELDS = ['partner_name', 'email_from', 'partner_phone', 'job_id', 'applicant_notes', 'linkedin_profile', 'stage_id', 'source_id', 'attachment_ids', 'active'];
  const fieldsOf = (model) =>
    ({
      'hr.applicant': APPLICANT_FIELDS,
      'hr.job': ['name', 'is_published', 'active', 'department_id', 'description'],
      'ir.attachment': ['name', 'datas', 'res_model', 'res_id', 'mimetype'],
    }[model]);

  // Minimal domain evaluation for the domains the integration uses
  const matches = (rec, domain = []) =>
    domain.every(([field, op, value]) => {
      const v = rec[field];
      if (op === '=') return value === false ? !v : v === value;
      if (op === '=ilike') return String(v || '').toLowerCase() === String(value).toLowerCase();
      if (op === 'ilike') return String(v || '').toLowerCase().includes(String(value).toLowerCase());
      throw new Error(`fake odoo: unsupported operator ${op}`);
    });

  const table = (model) => ({ 'hr.applicant': state.applicants, 'hr.job': state.jobs, 'ir.attachment': state.attachments, 'utm.source': state.sources }[model]);

  const handle = (model, method, p) => {
    if (method === 'fields_get') {
      const f = fieldsOf(model);
      if (!f) return { status: 404, body: { name: 'werkzeug.exceptions.NotFound', message: `the model '${model}' does not exist` } };
      return { body: Object.fromEntries(f.map((n) => [n, { type: 'char' }])) };
    }
    if (method === 'has_access') return { body: true };
    if (model === 'res.users' && method === 'search_count') return { body: 1 };
    const rows = table(model);
    if (!rows) return { status: 404, body: { message: `the model '${model}' does not exist` } };
    if (method === 'search_count') return { body: rows.filter((r) => matches(r, p.domain)).length };
    if (method === 'search_read') {
      const found = rows.filter((r) => matches(r, p.domain)).slice(0, p.limit || undefined);
      return { body: found.map((r) => ({ id: r.id, ...Object.fromEntries((p.fields || []).map((f) => [f, r[f] ?? false])) })) };
    }
    if (method === 'create') {
      const ids = p.vals_list.map((vals) => {
        const id = (state.nextId += 1);
        if (model === 'hr.applicant') {
          const unknown = Object.keys(vals).filter((k) => !APPLICANT_FIELDS.includes(k));
          if (unknown.length) throw Object.assign(new Error(`Invalid field ${unknown.join(', ')} on model hr.applicant`), { status: 422 });
        }
        if (model === 'ir.attachment') {
          const { datas, ...rest } = vals;
          rows.push({ id, ...rest, size: Buffer.from(datas, 'base64').length });
        } else rows.push({ id, active: true, ...vals });
        return id;
      });
      return { body: ids };
    }
    if (method === 'write') {
      rows.filter((r) => p.ids.includes(r.id)).forEach((r) => Object.assign(r, p.vals));
      return { body: true };
    }
    if (method === 'message_post') {
      state.messages.push({ model, ids: p.ids, body: p.body });
      return { body: state.nextId++ };
    }
    return { status: 404, body: { message: `fake odoo: ${model}.${method} not implemented` } };
  };

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
    });
    req.on('end', () => {
      const send = (status, body) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.url === '/web/webclient/version_info') return send(200, { jsonrpc: '2.0', result: { server_version: '19.0+e', server_serie: '19.0' } });
      const m = req.url.match(/^\/json\/2\/([\w.]+)\/(\w+)$/);
      if (!m) return send(404, { message: 'Not Found' });
      const [, model, method] = m;
      state.calls.push(`${model}.${method}`);
      if (state.mode === 'down') return send(503, { message: 'Service Unavailable' });
      if (req.headers.authorization !== `bearer ${apiKey}` || req.headers['x-odoo-database'] !== db) return send(401, { message: 'Invalid apikey' });
      if (state.mode === 'denied' && ['create', 'write'].includes(method)) return send(403, { name: 'odoo.exceptions.AccessError', message: `You are not allowed to modify '${model}' records.` });
      try {
        const out = handle(model, method, JSON.parse(raw || '{}'));
        return send(out.status || 200, out.body);
      } catch (err) {
        return send(err.status || 500, { message: err.message });
      }
    });
  });

  return { server, state };
};
