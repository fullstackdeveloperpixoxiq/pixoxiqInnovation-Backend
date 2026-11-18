import AiConfig from '../models/AiConfig.js';
import ApiError from '../utils/ApiError.js';
import { decryptSecret } from './crypto.js';
import { getAdapter, getProvider, ProviderError } from './providers/index.js';
import { redact } from './redact.js';

// Resolves the AI provider configuration saved by a superadmin into ready-to-use clients.
// There is no default provider/model and no fallback: if nothing is configured, callers get
// an AiConfigError; if the configured provider fails, the error is reported as-is.

export class AiConfigError extends ApiError {
  constructor(message) {
    super(503, message);
    this.code = 'ai_not_configured';
  }
}

const CACHE_MS = 15000;
let cache = { at: 0, doc: null };

export const invalidateAiConfig = () => {
  cache = { at: 0, doc: null };
};

const loadConfig = async () => {
  if (cache.doc && Date.now() - cache.at < CACHE_MS) return cache.doc;
  const doc = await AiConfig.getSingleton({ withSecrets: true });
  cache = { at: Date.now(), doc };
  return doc;
};

export const embeddingKeyOf = (target) => (target?.provider && target?.model ? `${target.provider}:${target.model}` : '');

const MAX_EMBED_BATCH = 64;
const MAX_EMBED_CHARS = 8000;

// Builds a client object for one configured target (chat or embedding)
export const buildClient = ({ purpose, provider, model, baseUrl, apiKey }) => {
  const def = getProvider(provider);
  if (!def) throw new AiConfigError(`Unknown AI provider "${provider}"`);
  const resolvedBaseUrl = (baseUrl || def.baseUrl || '').replace(/\/+$/, '');
  if (!resolvedBaseUrl) throw new AiConfigError(`A base URL is required for ${def.label}`);
  const adapter = getAdapter(def.adapter);
  const base = { def, apiKey, baseUrl: resolvedBaseUrl, model };

  return {
    purpose,
    provider,
    providerLabel: def.label,
    model,
    key: `${provider}:${model}`,
    secrets: [apiKey],
    chat: (opts) => adapter.chat({ ...base, ...opts }),
    listModels: (opts = {}) => adapter.listModels({ ...base, purpose, ...opts }),
    // Embeds any number of texts in batches; returns unit-length vectors
    embed: async (texts, { taskType, signal } = {}) => {
      const vectors = [];
      let inputTokens = 0;
      for (let i = 0; i < texts.length; i += MAX_EMBED_BATCH) {
        const batch = texts.slice(i, i + MAX_EMBED_BATCH).map((t) => String(t).slice(0, MAX_EMBED_CHARS));
        const result = await adapter.embed({ ...base, inputs: batch, taskType, signal });
        result.vectors.forEach((v) => {
          if (!Array.isArray(v) || !v.length) throw new ProviderError('The provider returned an empty embedding', { code: 'bad_embeddings' });
          vectors.push(normalize(v));
        });
        inputTokens += result.usage?.inputTokens || 0;
      }
      return { vectors, inputTokens };
    },
  };
};

export const normalize = (v) => {
  let sum = 0;
  for (let i = 0; i < v.length; i += 1) sum += v[i] * v[i];
  const norm = Math.sqrt(sum) || 1;
  return v.map((x) => x / norm);
};

const clientFromStored = (target, purpose) => {
  if (!target?.provider || !target?.model) return null;
  return buildClient({
    purpose,
    provider: target.provider,
    model: target.model,
    baseUrl: target.baseUrl,
    apiKey: decryptSecret(target.apiKeyEnc),
  });
};

// The chat model is required for the assistant to work at all
export const getChatClient = async () => {
  const config = await loadConfig();
  const client = clientFromStored(config.chat, 'chat');
  if (!client) {
    throw new AiConfigError('The AI assistant has no AI provider and model configured. A superadmin must configure one in Admin → AI Assistant → AI Configuration.');
  }
  return client;
};

// The embedding model is optional: without it, knowledge retrieval uses keyword search only
export const getEmbeddingClient = async () => {
  const config = await loadConfig();
  return clientFromStored(config.embedding, 'embedding');
};

export const getActiveEmbeddingKey = async () => embeddingKeyOf((await loadConfig()).embedding);

// Lightweight description used by the public status endpoint and the admin overview
export const getConfigSummary = async () => {
  const config = await loadConfig();
  const describe = (t) => ({
    configured: Boolean(t?.provider && t?.model),
    provider: t?.provider || '',
    providerLabel: getProvider(t?.provider)?.label || '',
    model: t?.model || '',
    status: t?.status || {},
  });
  return { chat: describe(config.chat), embedding: describe(config.embedding) };
};

const modelMatches = (id, model) => id === model || id === `models/${model}` || id.endsWith(`/${model}`);

// Finish reasons meaning "ran out of output tokens" (OpenAI-style, Anthropic, Gemini)
const TOKEN_LIMIT_REASONS = ['length', 'max_tokens', 'MAX_TOKENS'];
export const hitTokenLimit = (finishReason) => TOKEN_LIMIT_REASONS.includes(finishReason);
export const TOKEN_LIMIT_HINT =
  'The model used its whole output token budget without producing text. Reasoning/thinking models spend part of that budget on hidden reasoning: raise "Max output tokens" in Chatbot Settings.';

// The chat request that validation sends: the same generation parameters real chats use, so
// a model that rejects them (e.g. a custom temperature) fails here instead of in production.
export const liveChatCheck = (client, { temperature } = {}) =>
  client.chat({
    system: 'You are a connectivity test. Follow the instruction exactly.',
    messages: [{ role: 'user', content: 'Reply with the single word: OK' }],
    temperature: typeof temperature === 'number' ? temperature : undefined,
    maxTokens: 256,
  });

// Live validation of credentials + model. Returns a report; never throws for provider errors.
// `temperature` is the one from Chatbot Settings (null/undefined = provider default).
export const validateTarget = async ({ purpose, provider, model, baseUrl, apiKey, temperature }) => {
  const steps = [];
  const started = Date.now();
  const report = (ok, extra = {}) => ({ ok, steps, latencyMs: Date.now() - started, ...extra });
  const fail = (name, message) => {
    steps.push({ name, ok: false, message: redact(message, [apiKey]) });
    return report(false, { message: redact(message, [apiKey]) });
  };

  const def = getProvider(provider);
  if (!def) return fail('Provider', `Unknown provider "${provider}"`);
  if (purpose === 'embedding' && !def.embeddings) return fail('Provider', `${def.label} does not offer an embeddings API`);
  if (purpose === 'chat' && !def.chat) return fail('Provider', `${def.label} does not offer a chat API`);
  if (!model) return fail('Model', 'A model id is required. There is no default model.');
  if (def.requiresKey && !apiKey) return fail('API key', `${def.label} requires an API key`);
  const url = baseUrl || def.baseUrl;
  if (!url) return fail('Base URL', 'A base URL is required for this provider');
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error();
  } catch {
    return fail('Base URL', 'The base URL must be a valid http(s) URL');
  }
  steps.push({ name: 'Configuration', ok: true, message: `${def.label} · ${model}` });

  const client = buildClient({ purpose, provider, model, baseUrl: url, apiKey });

  // 1. Credentials + model availability via the provider's model list
  let modelCount = null;
  try {
    const models = await client.listModels();
    modelCount = models.length;
    if (models.length && !models.some((m) => modelMatches(m.id, model))) {
      return fail('Model availability', `Model "${model}" is not available with these credentials (${models.length} models are). Check the model id.`);
    }
    steps.push({
      name: 'Credentials & model',
      ok: true,
      message: models.length ? `Authenticated; "${model}" is available` : 'Authenticated (the provider returned no model list)',
    });
  } catch (err) {
    if (err.code === 'auth_failed' || err.code === 'network_error' || err.code === 'timeout') return fail('Credentials', err.message);
    // Some OpenAI-compatible servers do not implement /models: rely on the live call below
    steps.push({ name: 'Model list', ok: true, message: `Model list not available (${err.message}); verifying with a live request` });
  }

  // 2. A real request to the model
  try {
    if (purpose === 'embedding') {
      const { vectors } = await client.embed(['PIXOXIQ connectivity test'], { taskType: 'query' });
      steps.push({ name: 'Live request', ok: true, message: `Embedding returned ${vectors[0].length} dimensions` });
      return report(true, { dimensions: vectors[0].length, modelCount, message: 'Connection successful' });
    }
    const result = await liveChatCheck(client, { temperature });
    const sample = (result.text || '').trim().slice(0, 120);
    let message = sample ? `Model replied: "${sample}"` : `Model responded (finish reason: ${result.finishReason || 'unknown'})`;
    if (!sample && hitTokenLimit(result.finishReason)) message += `. Note: ${TOKEN_LIMIT_HINT}`;
    steps.push({ name: 'Live request', ok: true, message });
    return report(true, { sample, usage: result.usage, modelCount, message: 'Connection successful' });
  } catch (err) {
    const hint =
      typeof temperature === 'number'
        ? ` (The temperature ${temperature} from Chatbot Settings was included in this test. If the model does not accept it, clear the temperature there to use the provider default.)`
        : '';
    return fail('Live request', `${err.message || 'Request failed'}${hint}`);
  }
};
