import { createApp } from './app.js';
import { env } from './config/env.js';
import { serverKeyHolder } from './crypto/serverKeyHolder.js';
import { demoService } from './services/demo.service.js';

function bootstrap(): void {
  // 1. Seed demo accounts in in-memory database
  demoService.seedAccounts();

  // 2. Initialize and start HTTP server
  const app = createApp();
  const server = app.listen(env.PORT, () => {
    console.info(
      {
        port: env.PORT,
        dashboardUrl: `http://localhost:${env.PORT}`,
        serverKeyFingerprint: serverKeyHolder.getPublicKeyBase64().substring(0, 32) + '...',
      },
      'UPI Offline Mesh server started successfully'
    );
  });

  // Graceful shutdown handling
  const shutdown = (signal: string): void => {
    console.info({ signal }, 'Received termination signal, shutting down gracefully...');
    server.close(() => {
      console.info('HTTP server closed.');
      process.exit(0);
    });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

bootstrap();
