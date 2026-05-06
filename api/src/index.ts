import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import healthRouter from './routes/health';
import sitesRouter from './routes/sites';
import hostedRouter from './routes/hosted';
import dnsRouter from './routes/dns';
import backupRouter from './routes/backup';
import configRouter from './routes/config';
import statsRouter from './routes/stats';
import servicesRouter from './routes/services';
import authRouter from './routes/auth';
import { requireAuth } from './middleware/auth';
import { getDeployedSite } from './services/githubDeploy';
import { startStatsIngester } from './services/statsIngester';
import { startLiveStats } from './services/liveStats';
import { readNsHostname, readNsServerIp } from './routes/config';
import { createTechnitiumClient } from './services/technitium';
import { ensureNsGlueRecords, cleanBadNsRecords, provisionTraefikRoute, provisionTraefikRouteForCompose } from './routes/sites';
import { createCoolifyClient } from './services/coolify';
import { resolveRouteDomain } from './services/mapper';
import { existsSync } from 'fs';
import * as path from 'path';

const app = express();
const PORT = process.env.PORT ?? 3001;

// Middleware
const _corsRaw = process.env.CORS_ORIGIN ?? 'http://localhost:3000';
const _corsOrigins = _corsRaw.includes(',')
  ? _corsRaw.split(',').map(s => s.trim())
  : _corsRaw;
app.use(cors({ origin: _corsOrigins, credentials: true }));
app.use(express.json());

// ── Auth routes — mounted BEFORE requireAuth so login/logout/check are public ──
app.use('/api/auth', authRouter);

// ── Public routes — no auth required ──
app.use('/api/health', healthRouter);

// ── requireAuth guards all remaining /api/* routes ──
app.use('/api', requireAuth);

// Protected API routes
app.use('/api/sites', sitesRouter);
app.use('/api/hosted', hostedRouter);
app.use('/api/dns', dnsRouter);
app.use('/api/backup', backupRouter);
app.use('/api/config', configRouter);
app.use('/api/sites/:slug/stats', statsRouter);
app.use('/api/services', servicesRouter);

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

  // Start stats ingester (reads Traefik access log → SQLite rollups)
  startStatsIngester();
  // Start live stats scraper (Traefik Prometheus → SSE)
  startLiveStats();

  // Non-blocking DNS startup fixup — sets dnsServerDomain, creates glue records,
  // and removes stale container-ID NS records left from unconfigured Technitium.
  (async () => {
    const nsHostname = readNsHostname();
    const serverIp = readNsServerIp();
    const client = createTechnitiumClient();
    if (!client || !nsHostname) {
      console.warn('[dns-init] Skipping: Technitium or NS_HOSTNAME not configured');
      return;
    }
    try {
      await client.setDnsServerDomain(nsHostname);
      console.log(`[dns-init] dnsServerDomain → ${nsHostname}`);
    } catch (err) {
      console.warn('[dns-init] setDnsServerDomain failed:', (err as Error).message);
    }
    if (serverIp) {
      await ensureNsGlueRecords(client, nsHostname, serverIp);
    } else {
      console.warn('[dns-init] NS_SERVER_IP not set — skipping glue record provisioning');
    }
    await cleanBadNsRecords(client);
  })();

  // Non-blocking startup route sync — regenerates any missing Traefik route files
  // for active Coolify applications. Route files are gitignored (traefik/conf.d/site-*.yml)
  // and are lost on fresh clones or after sanitization. This ensures sites remain
  // accessible without requiring a manual PATCH to each site.
  (async () => {
    try {
      const coolifyClient = createCoolifyClient();
      if (!coolifyClient) {
        console.warn('[startup-sync] Coolify client not available — skipping route sync');
        return;
      }
      const confDir = process.env.TRAEFIK_CONF_DIR ?? '/app/traefik-conf.d';
      const { readNetworkMode } = await import('./routes/config');
      const resolver = readNetworkMode() === 'internal' ? 'internal-ca' : 'letsencrypt';

      let applications: Awaited<ReturnType<typeof coolifyClient.listApplications>>;
      try {
        applications = await coolifyClient.listApplications();
      } catch (listErr) {
        console.warn('[startup-sync] Failed to list applications from Coolify:', (listErr as Error).message);
        return;
      }

      for (const app of applications) {
        const slug = app.uuid;
        const routeFile = path.join(confDir, `site-${slug}.yml`);
        if (existsSync(routeFile)) continue;

        const domain = resolveRouteDomain(app);
        if (!domain) {
          console.warn(`[startup-sync] No domain for app ${slug} — skipping`);
          continue;
        }

        try {
          let result: { ok: boolean; reason?: string };
          if (app.build_pack === 'dockercompose') {
            const freshApp = await coolifyClient.getApplication(slug).catch(() => app);
            result = await provisionTraefikRouteForCompose(createCoolifyClient()!, freshApp, domain, resolver);
          } else {
            const port = (app as any).ports_exposes ?? 3000;
            result = await provisionTraefikRoute(slug, domain, port, resolver);
          }
          if (result.ok) {
            console.log(`[startup-sync] regenerated missing route for ${domain}`);
          } else {
            console.warn(`[startup-sync] failed to regenerate route for ${domain}: ${result.reason}`);
          }
        } catch (routeErr) {
          console.warn(`[startup-sync] error regenerating route for ${slug}:`, (routeErr as Error).message);
        }
      }
    } catch (err) {
      console.warn('[startup-sync] Unexpected error during route sync:', (err as Error).message);
    }
  })();
});

export default app;
