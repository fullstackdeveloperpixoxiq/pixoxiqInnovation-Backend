import { ProviderError, joinUrl, parseJson, requestJson, streamSse } from './http.js';

// Adapter for the Anthropic Messages API

const API_VERSION = '2023-06-01';

const headers = (apiKey) => ({ 'x-api-key': apiKey, 'anthropic-version': API_VERSION });

export const chat = async ({ apiKey, baseUrl, model, system, messages, temperature, maxTokens, signal, onDelta }) => {
  if (!maxTokens) throw new ProviderError('Anthropic requires a maximum output token value', { code: 'bad_request', status: 400 });
  const url = joinUrl(baseUrl, 'messages');
  const body = {
    model,
    system,
    max_tokens: maxTokens,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
  };
  if (typeof temperature === 'number') body.temperature = Math.min(temperature, 1);

  if (!onDelta) {
    const json = await requestJson(url, { method: 'POST', headers: headers(apiKey), body, signal });
    const text = (json.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    return {
      text,
      usage: json.usage ? { inputTokens: json.usage.input_tokens ?? null, outputTokens: json.usage.output_tokens ?? null } : null,
      finishReason: json.stop_reason || null,
    };
  }

  body.stream = true;
  let text = '';
  const usage = { inputTokens: null, outputTokens: null };
  let finishReason = null;

  for await (const { event, data } of streamSse(url, { headers: headers(apiKey), body, signal })) {
    const json = parseJson(data);
    if (!json) continue;
    const type = json.type || event;
    if (type === 'error') {
      throw new ProviderError(`Provider error: ${json.error?.message || 'unknown error'}`, {
        code: json.error?.type === 'overloaded_error' ? 'provider_unavailable' : 'stream_error',
      });
    }
    if (type === 'message_start') usage.inputTokens = json.message?.usage?.input_tokens ?? null;
    if (type === 'content_block_delta' && json.delta?.type === 'text_delta') {
      text += json.delta.text;
      onDelta(json.delta.text);
    }
    if (type === 'message_delta') {
      if (json.usage?.output_tokens != null) usage.outputTokens = json.usage.output_tokens;
      if (json.delta?.stop_reason) finishReason = json.delta.stop_reason;
    }
    if (type === 'message_stop') break;
  }
  return { text, usage, finishReason };
};

export const listModels = async ({ apiKey, baseUrl, signal }) => {
  const json = await requestJson(joinUrl(baseUrl, 'models?limit=1000'), { headers: headers(apiKey), signal, timeoutMs: 20000 });
  return (json.data || [])
    .map((m) => ({ id: m.id, label: m.display_name }))
    .filter((m) => m.id);
};

export const embed = async () => {
  throw new ProviderError('Anthropic does not provide an embeddings API. Choose another embedding provider.', {
    code: 'unsupported',
    status: 400,
  });
};
