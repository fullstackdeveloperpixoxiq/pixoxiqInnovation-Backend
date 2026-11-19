import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import env from './config/env.js';
import routes from './routes/index.js';
import { notFound, errorHandler } from './middleware/errorHandler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();

app.set('trust proxy', 1);

// Uploaded images are loaded by the public site from a different origin
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));

const corsOptions = {
  origin(origin, callback) {
    // Allow server-to-server / curl requests (no origin) and configured clients
    if (!origin || env.clientUrls.includes(origin.replace(/\/+$/, ''))) return callback(null, true);
    // In development allow any localhost port (Vite picks a free port)
    if (!env.isProd && /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)) {
      return callback(null, true);
    }
    // Unknown origin: send no CORS headers (browser blocks it) instead of a 500
    return callback(null, false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  // X-Chat-Session: anonymous AI assistant session token sent by the public website
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'X-Chat-Session'],
  maxAge: 86400,
  optionsSuccessStatus: 204,
};

// CORS must run before body parsing, routes and auth so preflights never hit `protect`
app.use(cors(corsOptions));
// Disallowed-origin preflights get an empty 204 without CORS headers (browser blocks them)
app.use((req, res, next) => (req.method === 'OPTIONS' ? res.sendStatus(204) : next()));

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
if (!env.isProd) app.use(morgan('dev'));

app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads'), { maxAge: '7d' }));

// Uptime monitor endpoint (UptimeRobot): public, no auth, no DB access.
// Express answers HEAD requests with this GET handler too.
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    message: 'Backend is running',
    timestamp: new Date().toISOString(),
  });
});

app.get('/api/health', (req, res) => {
  res.json({ success: true, status: 'ok', time: new Date().toISOString() });
});

app.use('/api', routes);

app.use(notFound);
app.use(errorHandler);

export default app;
