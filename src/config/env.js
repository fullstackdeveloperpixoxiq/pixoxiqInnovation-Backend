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
  seedAdmin: {
    name: process.env.SEED_ADMIN_NAME || 'Pixoxiq Admin',
    email: process.env.SEED_ADMIN_EMAIL || 'admin@pixoxiq.com',
    password: process.env.SEED_ADMIN_PASSWORD || 'Admin@12345',
  },
};

export default env;
