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
  // Public website URL, used in newsletter verification / unsubscribe links
  siteUrl: (process.env.SITE_URL || 'https://www.pixoxiq.com').replace(/\/+$/, ''),
  // Newsletter email delivery. EMAIL_PROVIDER: "resend" or "brevo" (auto-detected from the key
  // that is set when omitted). Without a provider, subscriptions are confirmed immediately
  // (no verification email) and newsletters cannot be sent.
  email: {
    provider: (process.env.EMAIL_PROVIDER || (process.env.RESEND_API_KEY ? 'resend' : process.env.BREVO_API_KEY ? 'brevo' : '')).toLowerCase(),
    resendApiKey: process.env.RESEND_API_KEY || '',
    brevoApiKey: process.env.BREVO_API_KEY || '',
    fromEmail: process.env.EMAIL_FROM || process.env.BREVO_SENDER_EMAIL || '',
    fromName: process.env.EMAIL_FROM_NAME || process.env.BREVO_SENDER_NAME || 'PIXOXIQ Innovations',
  },
  seedAdmin: {
    name: process.env.SEED_ADMIN_NAME || 'Pixoxiq Admin',
    email: process.env.SEED_ADMIN_EMAIL || 'admin@pixoxiq.com',
    password: process.env.SEED_ADMIN_PASSWORD || 'Admin@12345',
  },
};

export default env;
