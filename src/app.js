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

app.use(
  cors({
    origin(origin, callback) {
      // Allow server-to-server / curl requests (no origin) and configured clients
      if (!origin || env.clientUrls.includes(origin)) return callback(null, true);
      // In development allow any localhost port (Vite picks a free port)
      if (!env.isProd && /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)) {
        return callback(null, true);
      }
      return callback(new Error(`Origin ${origin} not allowed by CORS`));
    },
    credentials: true,
  })
);

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
if (!env.isProd) app.use(morgan('dev'));

app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads'), { maxAge: '7d' }));

app.get('/api/health', (req, res) => {
  res.json({ success: true, status: 'ok', time: new Date().toISOString() });
});

app.use('/api', routes);

app.use(notFound);
app.use(errorHandler);

export default app;
