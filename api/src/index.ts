import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import healthRouter from './routes/health';
import sitesRouter from './routes/sites';

const app = express();
const PORT = process.env.PORT ?? 3001;

// Middleware
app.use(cors({ origin: process.env.CORS_ORIGIN ?? 'http://localhost:3000' }));
app.use(express.json());

// Routes
app.use('/api/health', healthRouter);
app.use('/api/sites', sitesRouter);

// 404 handler
app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'Not found' });
});

// Error handler — never expose stack traces to clients
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[error]', err.message, err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`hermithost API running on http://localhost:${PORT}`);
  const coolifyUrl = process.env.COOLIFY_API_URL;
  if (coolifyUrl) {
    console.log(`[coolify] Integration active — base URL: ${coolifyUrl}`);
  } else {
    console.log('[coolify] No COOLIFY_API_URL set — running in mock data mode');
  }
  const technitiumUrl = process.env.TECHNITIUM_URL;
  if (technitiumUrl) {
    console.log(`[technitium] Integration active — base URL: ${technitiumUrl}`);
  } else {
    console.log('[technitium] No TECHNITIUM_URL set — DNS in mock mode');
  }
});

export default app;
