// Supported AI providers. None of them is a default: a superadmin must pick a provider AND
// enter/select a model id in the admin panel. To add a provider, add an entry here; if it
// speaks a new wire protocol, add an adapter in this folder and register it in index.js.
//
//  adapter         which wire protocol (adapter module) is used
//  baseUrl         API root; `customBaseUrl` lets the admin edit it (self-hosted / proxies)
//  requiresKey     whether an API key must be supplied
//  chat/embeddings which capabilities the provider offers
//  tokenParam      name of the max-output-tokens field (OpenAI-style APIs differ)
//  streamUsage     send stream_options.include_usage to get token counts while streaming

export const PROVIDERS = {
  openai: {
    label: 'OpenAI',
    adapter: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    requiresKey: true,
    chat: true,
    embeddings: true,
    tokenParam: 'max_completion_tokens',
    streamUsage: true,
    docsUrl: 'https://platform.openai.com/docs/models',
  },
  anthropic: {
    label: 'Anthropic (Claude)',
    adapter: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    requiresKey: true,
    chat: true,
    embeddings: false,
    docsUrl: 'https://docs.anthropic.com/en/docs/about-claude/models',
  },
  gemini: {
    label: 'Google Gemini',
    adapter: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    requiresKey: true,
    chat: true,
    embeddings: true,
    docsUrl: 'https://ai.google.dev/gemini-api/docs/models',
  },
  groq: {
    label: 'Groq',
    adapter: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1',
    requiresKey: true,
    chat: true,
    embeddings: false,
    tokenParam: 'max_tokens',
    streamUsage: true,
    docsUrl: 'https://console.groq.com/docs/models',
  },
  openrouter: {
    label: 'OpenRouter',
    adapter: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    requiresKey: true,
    chat: true,
    embeddings: false,
    tokenParam: 'max_tokens',
    streamUsage: true,
    docsUrl: 'https://openrouter.ai/models',
  },
  mistral: {
    label: 'Mistral AI',
    adapter: 'openai',
    baseUrl: 'https://api.mistral.ai/v1',
    requiresKey: true,
    chat: true,
    embeddings: true,
    tokenParam: 'max_tokens',
    streamUsage: false,
    docsUrl: 'https://docs.mistral.ai/getting-started/models/',
  },
  deepseek: {
    label: 'DeepSeek',
    adapter: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    requiresKey: true,
    chat: true,
    embeddings: false,
    tokenParam: 'max_tokens',
    streamUsage: true,
    docsUrl: 'https://api-docs.deepseek.com/',
  },
  ollama: {
    label: 'Ollama (self-hosted)',
    adapter: 'openai',
    baseUrl: 'http://localhost:11434/v1',
    customBaseUrl: true,
    requiresKey: false,
    chat: true,
    embeddings: true,
    tokenParam: 'max_tokens',
    streamUsage: false,
    docsUrl: 'https://ollama.com/library',
  },
  custom: {
    label: 'Custom OpenAI-compatible API',
    adapter: 'openai',
    baseUrl: '',
    customBaseUrl: true,
    requiresKey: false,
    chat: true,
    embeddings: true,
    tokenParam: 'max_tokens',
    streamUsage: false,
    docsUrl: '',
  },
};

export const getProvider = (id) => (Object.prototype.hasOwnProperty.call(PROVIDERS, id) ? PROVIDERS[id] : null);

// Safe description sent to the admin panel
export const publicCatalog = () =>
  Object.entries(PROVIDERS).map(([id, p]) => ({
    id,
    label: p.label,
    requiresKey: p.requiresKey,
    customBaseUrl: Boolean(p.customBaseUrl),
    defaultBaseUrl: p.baseUrl,
    chat: p.chat,
    embeddings: p.embeddings,
    docsUrl: p.docsUrl,
  }));
