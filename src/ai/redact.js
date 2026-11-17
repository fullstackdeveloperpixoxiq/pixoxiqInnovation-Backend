// Removes anything that looks like a credential from text before it is logged or returned.

const PATTERNS = [
  /sk-[A-Za-z0-9_\-]{12,}/g, // OpenAI / Anthropic / DeepSeek style
  /gsk_[A-Za-z0-9]{12,}/g, // Groq
  /AIza[0-9A-Za-z_\-]{20,}/g, // Google
  /(Bearer\s+)[A-Za-z0-9._\-]{12,}/gi,
  /([?&](?:key|api_key|apikey|token)=)[^&\s"']+/gi,
  /("?(?:x-api-key|x-goog-api-key|authorization|api[_-]?key)"?\s*[:=]\s*"?)[^"\s,}]+/gi,
];

export const redact = (text, secrets = []) => {
  let out = String(text ?? '');
  secrets.filter((s) => s && s.length >= 6).forEach((s) => {
    out = out.split(s).join('[REDACTED]');
  });
  PATTERNS.forEach((re) => {
    out = out.replace(re, (match, prefix) => (typeof prefix === 'string' && match.startsWith(prefix) ? `${prefix}[REDACTED]` : '[REDACTED]'));
  });
  return out;
};

export const maskKey = (key) => (key ? `••••${String(key).slice(-4)}` : '');
