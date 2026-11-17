import * as openai from './openai.js';
import * as anthropic from './anthropic.js';
import * as gemini from './gemini.js';

// Wire-protocol adapters. Every adapter exports the same functions:
//   chat({ def, apiKey, baseUrl, model, system, messages, temperature, maxTokens, signal, onDelta })
//     -> { text, usage: { inputTokens, outputTokens } | null, finishReason }
//     Streams when `onDelta` is given.
//   listModels({ apiKey, baseUrl, signal, purpose }) -> [{ id, label }]
//   embed({ apiKey, baseUrl, model, inputs, signal, taskType }) -> { vectors, usage }
const ADAPTERS = { openai, anthropic, gemini };

export const getAdapter = (name) => {
  const adapter = ADAPTERS[name];
  if (!adapter) throw new Error(`Unknown AI adapter "${name}"`);
  return adapter;
};

export { PROVIDERS, getProvider, publicCatalog } from './catalog.js';
export { ProviderError } from './http.js';
