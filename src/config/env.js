import dotenv from 'dotenv';

dotenv.config();

const required = ['MONGO_URI', 'JWT_SECRET'];
const missing = required.filter((key) => !process.env[key]);
if (missing.length) {
  console.error(`❌ Missing required env variables: ${missing.join(', ')}. Copy .env.example to .env`);
  process.exit(1);
}

const port = Number(process.env.PORT) || 5000;

const env = {
  port,
  nodeEnv: process.env.NODE_ENV || 'development',
  isProd: process.env.NODE_ENV === 'production',
  mongoUri: process.env.MONGO_URI,
  jwtSecret: process.env.JWT_SECRET,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  // Deployed admin panel is always allowed; CLIENT_URLS adds more (comma-separated)
  clientUrls: [
    ...new Set(
      ['https://pixoxiqinnovation-adminpanel.onrender.com', ...(process.env.CLIENT_URLS || 'http://localhost:5173').split(',')]
        .map((url) => url.trim().replace(/\/+$/, ''))
        .filter(Boolean)
    ),
  ],
  apiPublicUrl: (process.env.API_PUBLIC_URL || `http://localhost:${port}`).replace(/\/$/, ''),
  // AI assistant. There is deliberately NO default AI provider or model here: both are chosen
  // by a superadmin in the admin panel and stored (API keys encrypted) in the database.
  ai: {
    // 32-byte key (64 hex chars or base64) used to encrypt provider API keys at rest.
    // AI configuration cannot be saved until this is set.
    encryptionKey: process.env.AI_ENCRYPTION_KEY || '',
    // Per-IP limits for the public chat endpoints
    chatRequestsPerMinute: Number(process.env.CHAT_RATE_LIMIT_PER_MINUTE) || 12,
    sessionsPerHour: Number(process.env.CHAT_SESSIONS_PER_HOUR) || 30,
    // Timeout for a single provider request (ms)
    providerTimeoutMs: Number(process.env.AI_PROVIDER_TIMEOUT_MS) || 90000,
    // Max upload size for knowledge base documents (MB)
    maxDocumentMb: Number(process.env.KNOWLEDGE_MAX_FILE_MB) || 10,
  },
  seedAdmin: {
    name: process.env.SEED_ADMIN_NAME || 'Pixoxiq Admin',
    email: process.env.SEED_ADMIN_EMAIL || 'admin@pixoxiq.com',
    password: process.env.SEED_ADMIN_PASSWORD || 'Admin@12345',
  },
};

export default env;
