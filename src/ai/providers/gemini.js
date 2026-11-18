import { ProviderError, joinUrl, parseJson, requestJson, streamSse } from './http.js';

// Adapter for the Google Gemini API (generativelanguage.googleapis.com)

const headers = (apiKey) => ({ 'x-goog-api-key': apiKey });

const modelPath = (model) => (String(model).startsWith('models/') ? model : `models/${model}`);

const buildBody = ({ system, messages, temperature, maxTokens }) => {
  const generationConfig = {};
  if (typeof temperature === 'number') generationConfig.temperature = temperature;
  if (maxTokens) generationConfig.maxOutputTokens = maxTokens;
  return {
    systemInstruction: { parts: [{ text: system }] },
    contents: messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
    generationConfig,
  };
};

const readUsage = (u) => (u ? { inputTokens: u.promptTokenCount ?? null, outputTokens: u.candidatesTokenCount ?? null } : null);

const candidateText = (json) => {
  if (json.promptFeedback?.blockReason) {
    throw new ProviderError(`The provider blocked the request (${json.promptFeedback.blockReason})`, { code: 'blocked', status: 422 });
  }
  const parts = json.candidates?.[0]?.content?.parts || [];
  return parts.filter((p) => typeof p.text === 'string' && !p.thought).map((p) => p.text).join('');
};

export const chat = async ({ apiKey, baseUrl, model, system, messages, temperature, maxTokens, signal, onDelta }) => {
  const body = buildBody({ system, messages, temperature, maxTokens });

  if (!onDelta) {
    const json = await requestJson(joinUrl(baseUrl, `${modelPath(model)}:generateContent`), {
      method: 'POST',
      headers: headers(apiKey),
      body,
      signal,
    });
    return { text: candidateText(json), usage: readUsage(json.usageMetadata), finishReason: json.candidates?.[0]?.finishReason || null };
  }

  let text = '';
  let usage = null;
  let finishReason = null;
  const url = joinUrl(baseUrl, `${modelPath(model)}:streamGenerateContent?alt=sse`);
  for await (const { data } of streamSse(url, { headers: headers(apiKey), body, signal })) {
    const json = parseJson(data);
    if (!json) continue;
    if (json.error) throw new ProviderError(`Provider error: ${json.error.message || 'unknown error'}`, { code: 'stream_error' });
    const delta = candidateText(json);
    if (delta) {
      text += delta;
      onDelta(delta);
    }
    if (json.usageMetadata) usage = readUsage(json.usageMetadata);
    if (json.candidates?.[0]?.finishReason) finishReason = json.candidates[0].finishReason;
  }
  return { text, usage, finishReason };
};

export const listModels = async ({ apiKey, baseUrl, signal, purpose = 'chat' }) => {
  const method = purpose === 'embedding' ? 'embedContent' : 'generateContent';
  const models = [];
  let pageToken = '';
  do {
    const json = await requestJson(
      joinUrl(baseUrl, `models?pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`),
      { headers: headers(apiKey), signal, timeoutMs: 20000 }
    );
    (json.models || []).forEach((m) => {
      if (!m.supportedGenerationMethods || m.supportedGenerationMethods.includes(method)) {
        models.push({ id: String(m.name).replace(/^models\//, ''), label: m.displayName });
      }
    });
    pageToken = json.nextPageToken || '';
  } while (pageToken && models.length < 5000);
  return models;
};

export const embed = async ({ apiKey, baseUrl, model, inputs, signal, taskType }) => {
  const path = modelPath(model);
  const json = await requestJson(joinUrl(baseUrl, `${path}:batchEmbedContents`), {
    method: 'POST',
    headers: headers(apiKey),
    body: {
      requests: inputs.map((text) => ({
        model: path,
        content: { parts: [{ text }] },
        ...(taskType ? { taskType: taskType === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT' } : {}),
      })),
    },
    signal,
  });
  const vectors = (json.embeddings || []).map((e) => e.values);
  if (vectors.length !== inputs.length) throw new ProviderError('The provider returned an unexpected number of embeddings', { code: 'bad_embeddings' });
  return { vectors, usage: null };
};
