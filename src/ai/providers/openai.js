import { ProviderError, joinUrl, parseJson, requestJson, streamSse } from './http.js';

// Adapter for OpenAI and every OpenAI-compatible API (Groq, OpenRouter, Mistral, DeepSeek,
// Ollama, vLLM, LM Studio...). Differences between them are described in catalog.js.

const headers = (apiKey) => (apiKey ? { Authorization: `Bearer ${apiKey}` } : {});

const buildBody = ({ def, model, system, messages, temperature, maxTokens }) => {
  const body = {
    model,
    messages: [{ role: 'system', content: system }, ...messages.map((m) => ({ role: m.role, content: m.content }))],
  };
  if (typeof temperature === 'number') body.temperature = temperature;
  if (maxTokens) body[def.tokenParam || 'max_tokens'] = maxTokens;
  return body;
};

const readUsage = (usage) =>
  usage ? { inputTokens: usage.prompt_tokens ?? null, outputTokens: usage.completion_tokens ?? null } : null;

export const chat = async ({ def, apiKey, baseUrl, model, system, messages, temperature, maxTokens, signal, onDelta }) => {
  const url = joinUrl(baseUrl, 'chat/completions');
  const body = buildBody({ def, model, system, messages, temperature, maxTokens });

  if (!onDelta) {
    const json = await requestJson(url, { method: 'POST', headers: headers(apiKey), body, signal });
    const choice = json.choices?.[0];
    if (!choice) throw new ProviderError('The provider returned no answer', { code: 'empty_response' });
    return { text: choice.message?.content || '', usage: readUsage(json.usage), finishReason: choice.finish_reason || null };
  }

  body.stream = true;
  if (def.streamUsage) body.stream_options = { include_usage: true };

  let text = '';
  let usage = null;
  let finishReason = null;
  for await (const { data } of streamSse(url, { headers: headers(apiKey), body, signal })) {
    if (data === '[DONE]') break;
    const json = parseJson(data);
    if (!json) continue;
    if (json.error) throw new ProviderError(`Provider error: ${json.error.message || 'unknown error'}`, { code: 'stream_error' });
    if (json.usage) usage = readUsage(json.usage);
    const choice = json.choices?.[0];
    const delta = choice?.delta?.content;
    if (delta) {
      text += delta;
      onDelta(delta);
    }
    if (choice?.finish_reason) finishReason = choice.finish_reason;
  }
  return { text, usage, finishReason };
};

export const listModels = async ({ apiKey, baseUrl, signal }) => {
  const json = await requestJson(joinUrl(baseUrl, 'models'), { headers: headers(apiKey), signal, timeoutMs: 20000 });
  const items = Array.isArray(json.data) ? json.data : Array.isArray(json) ? json : [];
  return items
    .map((m) => ({ id: String(m.id || m.name || ''), label: m.name && m.name !== m.id ? m.name : undefined }))
    .filter((m) => m.id)
    .sort((a, b) => a.id.localeCompare(b.id));
};

export const embed = async ({ apiKey, baseUrl, model, inputs, signal }) => {
  const json = await requestJson(joinUrl(baseUrl, 'embeddings'), {
    method: 'POST',
    headers: headers(apiKey),
    body: { model, input: inputs },
    signal,
  });
  const rows = Array.isArray(json.data) ? [...json.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)) : [];
  if (rows.length !== inputs.length) throw new ProviderError('The provider returned an unexpected number of embeddings', { code: 'bad_embeddings' });
  return {
    vectors: rows.map((r) => r.embedding),
    usage: json.usage ? { inputTokens: json.usage.prompt_tokens ?? json.usage.total_tokens ?? null } : null,
  };
};
