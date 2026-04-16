import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import healthRouter from './routes/health';
import sitesRouter from './routes/sites';
import hostedRouter from './routes/hosted';
import { getDeployedSite } from './services/githubDeploy';

const app = express();
const PORT = process.env.PORT ?? 3001;

// Middleware
app.use(cors({ origin: process.env.CORS_ORIGIN ?? 'http://localhost:3000' }));
app.use(express.json());

// Routes
app.use('/api/health', healthRouter);
app.use('/api/sites', sitesRouter);
app.use('/api/hosted', hostedRouter);

// Dynamic static file serving for deployed sites
// GET /hosted/:slug/* → serves from the site's detected serveDir
app.use('/hosted/:slug', (req: Request, res: Response, next: NextFunction) => {
  const site = getDeployedSite(req.params.slug);
  if (!site) {
    res.status(404).json({ error: 'Deployed site not found' });
    return;
  }
  express.static(site.serveDir, { index: 'index.html' })(req, res, next);
});

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
    console.warn('[coolify] COOLIFY_API_URL not set — all Coolify routes will return 502');
  }
  const technitiumUrl = process.env.TECHNITIUM_URL;
  if (technitiumUrl) {
    console.log(`[technitium] Integration active — base URL: ${technitiumUrl}`);
  } else {
    console.warn('[technitium] TECHNITIUM_URL not set — DNS routes will fail at startup');
  }
});

export default app;
