import AiLog from '../models/AiLog.js';
import { redact } from './redact.js';

// Records an AI event in the AiLog collection (shown in the admin panel) and the server log.
// Everything is passed through redact() so API keys never end up in logs.
export const logAi = async ({ level = 'error', source, message, code, provider, model, providerStatus, context, secrets = [] }) => {
  const clean = redact(message, secrets).slice(0, 2000);
  const line = `[ai:${source}] ${level.toUpperCase()} ${provider ? `${provider}/${model || '?'} ` : ''}${clean}`;
  if (level === 'error') console.error(line);
  else console.warn(line);
  try {
    await AiLog.create({
      level,
      source,
      message: clean,
      code: code || '',
      provider: provider || '',
      model: model || '',
      providerStatus,
      context: context ? JSON.parse(redact(JSON.stringify(context), secrets)) : undefined,
    });
  } catch (err) {
    console.error('[ai] could not write AiLog:', err.message);
  }
};
