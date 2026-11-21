import env from './src/config/env.js';
import connectDB from './src/config/db.js';
import app from './src/app.js';
import { startAiBackgroundJobs } from './src/ai/maintenance.js';
import { emailStatus } from './src/services/emailService.js';

const start = async () => {
  await connectDB();
  startAiBackgroundJobs();

  const server = app.listen(env.port, () => {
    console.log(`🚀 API running on http://localhost:${env.port} (${env.nodeEnv})`);
    const mail = emailStatus();
    console.log(
      mail.configured
        ? `📧 Email: ${mail.provider} from ${mail.fromEmail}`
        : '⚠️  Email NOT configured (set EMAIL_PROVIDER, BREVO_API_KEY, EMAIL_FROM): registration OTPs cannot be sent'
    );
  });

  const shutdown = (signal) => {
    console.log(`\n${signal} received, shutting down...`);
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
};

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
  process.exit(1);
});

start();
