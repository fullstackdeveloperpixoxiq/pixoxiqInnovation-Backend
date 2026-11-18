import env from '../../config/env.js';

// Error raised by a provider adapter. The message is meant for admins (it is redacted again
// before being logged); website visitors only ever see a generic message.
export class ProviderError extends Error {
  constructor(message, { status = 502, code = 'provider_error', providerStatus } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.statusCode = status;
    this.code = code;
    this.providerStatus = providerStatus;
  }
}

const describeStatus = (status) => {
  if (status === 401 || status === 403) return { code: 'auth_failed', hint: 'Authentication failed: check the API key and its permissions.' };
  if (status === 404) return { code: 'not_found', hint: 'Not found: the model id or base URL is probably wrong.' };
  if (status === 429) return { code: 'rate_limited', hint: 'Rate limit or quota exceeded at the provider.' };
  if (status === 400 || status === 422) return { code: 'bad_request', hint: 'The provider rejected the request.' };
  if (status >= 500) return { code: 'provider_unavailable', hint: 'The provider is having problems.' };
  return { code: 'provider_error', hint: 'Unexpected provider response.' };
};

// Pulls a readable message out of the different error body shapes providers use
const extractProviderMessage = (body) => {
  if (!body) return '';
  if (typeof body === 'string') return body.slice(0, 500);
  const e = Array.isArray(body) ? body[0]?.error : body.error;
  if (typeof e === 'string') return e.slice(0, 500);
  return String(e?.message || body.message || body.detail || '').slice(0, 500);
};

export const providerHttpError = async (res) => {
  let body = null;
  try {
    const text = await res.text();
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  } catch {
    /* ignore */
  }
  const { code, hint } = describeStatus(res.status);
  const detail = extractProviderMessage(body);
  return new ProviderError(`${hint} (HTTP ${res.status})${detail ? `: ${detail}` : ''}`, {
    status: res.status === 429 ? 429 : 502,
    code,
    providerStatus: res.status,
  });
};

// Combines the caller's abort signal (e.g. the visitor closed the tab) with a timeout
export const withTimeout = (signal, ms = env.ai.providerTimeoutMs) => {
  const controller = new AbortController();
  const timer = setTimeout(
    () =>
      controller.abort(
        new ProviderError(`The provider did not respond within ${Math.round(ms / 1000)}s`, { code: 'timeout', status: 504 })
      ),
    ms
  );
  const onAbort = () => controller.abort(signal.reason);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    done: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    },
  };
};

const networkError = (err, signal) => {
  if (err instanceof ProviderError) return err;
  if (signal?.aborted && signal.reason instanceof ProviderError) return signal.reason;
  if (err?.name === 'AbortError' || signal?.aborted) return new ProviderError('Request was cancelled', { code: 'aborted', status: 499 });
  const cause = err?.cause?.code || err?.code || '';
  return new ProviderError(`Could not reach the provider${cause ? ` (${cause})` : ''}. Check the base URL and network access.`, {
    code: 'network_error',
    status: 502,
  });
};

// fetch wrapper: JSON in/out, timeout, normalised errors
export const requestJson = async (url, { method = 'GET', headers = {}, body, signal, timeoutMs } = {}) => {
  const t = withTimeout(signal, timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
      signal: t.signal,
    });
    if (!res.ok) throw await providerHttpError(res);
    return await res.json();
  } catch (err) {
    throw networkError(err, t.signal);
  } finally {
    t.done();
  }
};

// Sends a streaming request and yields the parsed Server-Sent Events: { event, data }
export async function* streamSse(url, { headers = {}, body, signal, timeoutMs } = {}) {
  const t = withTimeout(signal, timeoutMs);
  try {
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { Accept: 'text/event-stream', 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: t.signal,
      });
    } catch (err) {
      throw networkError(err, t.signal);
    }
    if (!res.ok) throw await providerHttpError(res);
    if (!res.body) throw new ProviderError('The provider returned an empty stream', { code: 'empty_stream' });

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let event = 'message';
    let data = [];

    function* flush() {
      if (data.length) yield { event, data: data.join('\n') };
      event = 'message';
      data = [];
    }

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, nl).replace(/\r$/, '');
          buffer = buffer.slice(nl + 1);
          if (line === '') yield* flush();
          else if (line.startsWith(':')) continue;
          else if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
        }
      }
      const rest = buffer.trim();
      if (rest.startsWith('data:')) data.push(rest.slice(5).trim());
      yield* flush();
    } catch (err) {
      throw networkError(err, t.signal);
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* ignore */
      }
    }
  } finally {
    t.done();
  }
}

export const parseJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

export const joinUrl = (base, path) => `${String(base).replace(/\/+$/, '')}/${String(path).replace(/^\/+/, '')}`;
