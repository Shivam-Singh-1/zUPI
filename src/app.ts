import cors from 'cors';
import express, { Express, NextFunction, Request, Response } from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZodError } from 'zod';
import { env } from './config/env.js';
import { apiRouter } from './controllers/api.controller.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.resolve(__dirname, '../public');

export function createApp(): Express {
  const app = express();

  // 1. Cross-Origin Resource Sharing
  app.use(
    cors({
      origin: [env.FRONTEND_ORIGIN, 'http://localhost:8080', 'http://127.0.0.1:8080'],
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'X-Bridge-Node-Id', 'X-Hop-Count'],
    })
  );

  // 2. Body Parser
  app.use(express.json());

  // 3. Static Assets & Dashboard Route
  app.use(express.static(publicDir));
  app.get('/', (_req: Request, res: Response): void => {
    res.sendFile(path.join(publicDir, 'dashboard.html'));
  });

  // 4. API Endpoints
  app.use('/api', apiRouter);

  // 5. Centralized Error Handling Middleware
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    if (err instanceof ZodError) {
      res.status(400).json({
        error: 'Validation Error',
        details: err.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
      return;
    }

    const message = err instanceof Error ? err.message : 'Internal Server Error';
    console.error({ error: message }, 'Unhandled server error');
    res.status(500).json({ error: message });
  });

  return app;
}
