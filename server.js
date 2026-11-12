import env from './src/config/env.js';
import connectDB from './src/config/db.js';
import app from './src/app.js';

const start = async () => {
  await connectDB();

  const server = app.listen(env.port, () => {
    console.log(`🚀 API running on http://localhost:${env.port} (${env.nodeEnv})`);
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
