import AiConfig from '../models/AiConfig.js';
import ChatSettings from '../models/ChatSettings.js';
import KnowledgeChunk from '../models/KnowledgeChunk.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import { pickFields } from './crudFactory.js';
import { decryptSecret, encryptSecret, isEncryptionConfigured } from '../ai/crypto.js';
import { buildClient, embeddingKeyOf, invalidateAiConfig, validateTarget } from '../ai/configService.js';
import { getProvider, publicCatalog } from '../ai/providers/index.js';
import { generateReply, invalidateChatSettings, sanitizeUserMessage } from '../ai/chatService.js';
import { reindexAll } from '../ai/indexer.js';
import { logAi } from '../ai/logger.js';
import { redact } from '../ai/redact.js';

// AI provider configuration (superadmin) and assistant settings.
// API keys are write-only: they are encrypted before saving and only "••••last4" is returned.

const PURPOSES = ['chat', 'embedding'];

const checkPurpose = (purpose) => {
  if (!PURPOSES.includes(purpose)) throw ApiError.notFound('Unknown configuration target');
  return purpose;
};

const describeTarget = (t = {}) => ({
  configured: Boolean(t.provider && t.model),
  provider: t.provider || '',
  providerLabel: getProvider(t.provider)?.label || '',
  model: t.model || '',
  baseUrl: t.baseUrl || '',
  hasApiKey: Boolean(t.apiKeyEnc),
  apiKeyMasked: t.apiKeyLast4 ? `••••${t.apiKeyLast4}` : '',
  dimensions: t.dimensions || null,
  status: t.status || {},
  updatedAt: t.updatedAt || null,
});

const staleChunkCount = async (embedding) => {
  const key = embeddingKeyOf(embedding);
  if (!key) return 0;
  return KnowledgeChunk.countDocuments({ embeddingKey: { $ne: key } });
};

// Reads provider/model/baseUrl/apiKey from the request. A blank apiKey re-uses the saved key
// when the provider is unchanged, so admins can re-test without re-typing it.
const resolveInput = (body, stored) => {
  const provider = typeof body.provider === 'string' ? body.provider.trim() : '';
  const def = getProvider(provider);
  if (!def) throw ApiError.badRequest('Select an AI provider');

  const model = typeof body.model === 'string' ? body.model.trim() : '';
  if (model.length > 200 || /\s/.test(model)) throw ApiError.badRequest('Enter a valid model id');

  let baseUrl = '';
  if (def.customBaseUrl) {
    baseUrl = typeof body.baseUrl === 'string' && body.baseUrl.trim() ? body.baseUrl.trim().replace(/\/+$/, '') : def.baseUrl;
    if (!baseUrl) throw ApiError.badRequest('Enter the base URL of the API');
    if (baseUrl.length > 500) throw ApiError.badRequest('Base URL is too long');
  }

  let apiKey = '';
  let keyIsNew = false;
  if (typeof body.apiKey === 'string' && body.apiKey.trim()) {
    apiKey = body.apiKey.trim();
    keyIsNew = true;
    if (apiKey.length > 500 || /\s/.test(apiKey)) throw ApiError.badRequest('The API key format is invalid');
  } else if (!body.clearApiKey && stored?.provider === provider && stored.apiKeyEnc) {
    apiKey = decryptSecret(stored.apiKeyEnc);
  }

  return { provider, def, model, baseUrl, apiKey, keyIsNew };
};

export const getProviders = asyncHandler(async (req, res) => {
  res.json({ success: true, data: publicCatalog() });
});

export const getConfig = asyncHandler(async (req, res) => {
  const config = await AiConfig.getSingleton({ withSecrets: true });
  res.json({
    success: true,
    data: {
      chat: describeTarget(config.chat),
      embedding: describeTarget(config.embedding),
      encryptionReady: isEncryptionConfigured(),
      staleChunks: await staleChunkCount(config.embedding),
      providers: publicCatalog(),
    },
  });
});

export const listModels = asyncHandler(async (req, res) => {
  const purpose = checkPurpose(req.body.purpose);
  const config = await AiConfig.getSingleton({ withSecrets: true });
  const input = resolveInput({ ...req.body, model: req.body.model || '' }, config[purpose]);
  if (input.def.requiresKey && !input.apiKey) throw ApiError.badRequest(`${input.def.label} requires an API key`);
  const client = buildClient({ purpose, provider: input.provider, model: '', baseUrl: input.baseUrl, apiKey: input.apiKey });
  try {
    const models = await client.listModels();
    res.json({ success: true, data: models.slice(0, 3000) });
  } catch (err) {
    throw new ApiError(502, redact(`Could not list models: ${err.message}`, [input.apiKey]));
  }
});

export const testConfig = asyncHandler(async (req, res) => {
  const purpose = checkPurpose(req.body.purpose);
  const config = await AiConfig.getSingleton({ withSecrets: true });
  const stored = config[purpose];
  const input = resolveInput(req.body, stored);

  const report = await validateTarget({ purpose, ...input });

  // Testing the saved configuration refreshes its status on the dashboard
  const isSaved =
    !input.keyIsNew && stored.provider === input.provider && stored.model === input.model && (stored.baseUrl || '') === input.baseUrl;
  if (isSaved) {
    config[purpose].status = { ok: report.ok, checkedAt: new Date(), message: report.message, latencyMs: report.latencyMs };
    await config.save();
    invalidateAiConfig();
  }
  if (!report.ok) {
    await logAi({
      level: 'warn',
      source: 'config',
      message: `Connection test failed (${purpose}): ${report.message}`,
      provider: input.provider,
      model: input.model,
      secrets: [input.apiKey],
    });
  }
  res.json({ success: true, data: report });
});

export const saveTarget = asyncHandler(async (req, res) => {
  const purpose = checkPurpose(req.params.purpose);
  if (!isEncryptionConfigured()) {
    throw new ApiError(500, 'AI_ENCRYPTION_KEY is not set on the server, so API keys cannot be stored securely. Ask your developer to set it.');
  }
  const config = await AiConfig.getSingleton({ withSecrets: true });
  const stored = config[purpose];
  const previousKey = embeddingKeyOf(stored);
  const input = resolveInput(req.body, stored);

  // Never save a configuration that has not passed a live check
  const report = await validateTarget({ purpose, ...input });
  if (!report.ok) {
    await logAi({
      level: 'warn',
      source: 'config',
      message: `Rejected ${purpose} configuration: ${report.message}`,
      provider: input.provider,
      model: input.model,
      secrets: [input.apiKey],
    });
    return res.status(400).json({ success: false, message: `Configuration not saved: ${report.message}`, data: report });
  }

  config[purpose] = {
    provider: input.provider,
    model: input.model,
    baseUrl: input.baseUrl,
    apiKeyEnc: input.apiKey ? encryptSecret(input.apiKey) : '',
    apiKeyLast4: input.apiKey ? input.apiKey.slice(-4) : '',
    dimensions: report.dimensions || undefined,
    status: { ok: true, checkedAt: new Date(), message: report.message, latencyMs: report.latencyMs },
    updatedAt: new Date(),
    updatedBy: req.admin._id,
  };
  await config.save();
  invalidateAiConfig();

  await logAi({
    level: 'info',
    source: 'config',
    message: `${purpose === 'chat' ? 'Chat' : 'Embedding'} model set to ${input.provider}/${input.model} by ${req.admin.email}`,
    provider: input.provider,
    model: input.model,
  });

  // Vectors from a different embedding model cannot be compared: re-embed everything
  let reindexed = 0;
  if (purpose === 'embedding' && embeddingKeyOf(config.embedding) !== previousKey) reindexed = await reindexAll();

  res.json({
    success: true,
    message: reindexed ? `Saved. Re-indexing ${reindexed} knowledge entries with the new embedding model.` : 'AI configuration saved',
    data: { target: describeTarget(config[purpose]), report, reindexed },
  });
});

export const clearTarget = asyncHandler(async (req, res) => {
  const purpose = checkPurpose(req.params.purpose);
  const config = await AiConfig.getSingleton({ withSecrets: true });
  config[purpose] = { status: {} };
  await config.save();
  invalidateAiConfig();
  await logAi({ level: 'info', source: 'config', message: `${purpose} configuration removed by ${req.admin.email}` });
  res.json({
    success: true,
    message: purpose === 'chat' ? 'Chat model removed. The assistant is unavailable until a new one is configured.' : 'Embedding model removed. Retrieval now uses keyword search.',
  });
});

// ---------- Assistant settings ----------

const SETTINGS_FIELDS = [
  'enabled',
  'assistantName',
  'welcomeMessage',
  'suggestedQuestions',
  'additionalInstructions',
  'temperature',
  'maxOutputTokens',
  'historyWindow',
  'retrievalTopK',
  'minRelevance',
  'maxMessageLength',
  'dailyMessageLimit',
  'retentionDays',
];

export const getSettings = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await ChatSettings.getSingleton() });
});

export const updateSettings = asyncHandler(async (req, res) => {
  const settings = await ChatSettings.getSingleton();
  const data = pickFields(req.body, SETTINGS_FIELDS);
  if (data.temperature === '' || data.temperature === undefined) delete data.temperature;
  if (req.body.temperature === null || req.body.temperature === '') data.temperature = null;
  if (data.suggestedQuestions !== undefined && !Array.isArray(data.suggestedQuestions)) {
    throw ApiError.badRequest('suggestedQuestions must be a list');
  }
  ['assistantName', 'welcomeMessage', 'additionalInstructions'].forEach((f) => {
    if (data[f] !== undefined && typeof data[f] !== 'string') throw ApiError.badRequest(`${f} must be text`);
  });
  if (data.enabled !== undefined && typeof data.enabled !== 'boolean') throw ApiError.badRequest('enabled must be true or false');

  if (data.enabled === true && !settings.enabled) {
    const config = await AiConfig.getSingleton();
    if (!config.chat?.provider || !config.chat?.model) {
      throw ApiError.badRequest('Configure an AI provider and model before enabling the assistant.');
    }
  }

  settings.set({ ...data, updatedBy: req.admin._id });
  await settings.save();
  invalidateChatSettings();
  res.json({ success: true, message: 'Assistant settings saved', data: settings });
});

// ---------- Admin test chat (full pipeline, nothing stored) ----------

export const testChat = asyncHandler(async (req, res) => {
  const { text } = sanitizeUserMessage(req.body.message, 4000);
  if (!text) throw ApiError.badRequest('Enter a question');
  const history = Array.isArray(req.body.history)
    ? req.body.history
        .slice(-10)
        .filter((m) => ['user', 'assistant'].includes(m?.role) && typeof m.content === 'string')
        .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }))
    : [];

  try {
    const result = await generateReply({ history, message: text });
    res.json({
      success: true,
      data: {
        answer: result.text,
        finishReason: result.finishReason,
        retrievalMode: result.retrievalMode,
        sources: result.sources,
        contexts: result.contexts.map((c) => ({ title: c.title, category: c.category, score: c.score, text: c.text.slice(0, 400) })),
        usage: result.usage,
        latencyMs: result.latencyMs,
        provider: result.provider,
        model: result.model,
      },
    });
  } catch (err) {
    if (err instanceof ApiError && !err.client) throw err; // e.g. not configured
    await logAi({
      source: err.stage === 'retrieval' ? 'retrieval' : 'chat',
      message: `Admin test chat failed: ${err.message}`,
      code: err.code,
      provider: err.client?.provider,
      model: err.client?.model,
      providerStatus: err.providerStatus,
      secrets: err.client?.secrets,
    });
    throw new ApiError(502, redact(err.message || 'The AI request failed', err.client?.secrets));
  }
});
