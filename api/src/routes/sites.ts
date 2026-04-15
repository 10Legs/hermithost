import { Router, Request, Response } from 'express';
import { SITES, getSite, DnsRecord } from '../data/mock';
import { createCoolifyClient } from '../services/coolify';
import { mapSite, mapDeploy } from '../services/mapper';

const router = Router();

const useMock = !process.env.COOLIFY_API_URL;

// ── GET /api/sites — list all sites ──────────────────────────────────────────
router.get('/', async (_req: Request, res: Response) => {
  if (useMock) {
    res.status(200).json(SITES);
    return;
  }
  try {
    const client = createCoolifyClient()!;
    const applications = await client.listApplications();
    const sites = await Promise.all(
      applications.map(async (app) => {
        const deployments = await client.listDeployments(app.uuid).catch(() => []);
        return mapSite(app, deployments);
      })
    );
    res.status(200).json(sites);
  } catch (err) {
    console.warn('[coolify] GET /applications failed, falling back to mock:', (err as Error).message);
    res.setHeader('x-data-source', 'mock');
    res.status(200).json(SITES);
  }
});

// ── GET /api/sites/:slug — single site detail ─────────────────────────────────
router.get('/:slug', async (req: Request, res: Response) => {
  if (useMock) {
    const site = getSite(req.params.slug);
    if (!site) {
      res.status(404).json({ error: 'Site not found' });
      return;
    }
    res.status(200).json(site);
    return;
  }
  try {
    const client = createCoolifyClient()!;
    const app = await client.getApplication(req.params.slug);
    const deployments = await client.listDeployments(app.uuid).catch(() => []);
    res.status(200).json(mapSite(app, deployments));
  } catch (err) {
    console.warn(`[coolify] GET /applications/${req.params.slug} failed, falling back to mock:`, (err as Error).message);
    const site = getSite(req.params.slug);
    if (!site) {
      res.status(404).json({ error: 'Site not found' });
      return;
    }
    res.setHeader('x-data-source', 'mock');
    res.status(200).json(site);
  }
});

// ── GET /api/sites/:slug/dns — DNS records for a site ────────────────────────
// TODO: replace with Technitium API call
// GET http://<technitium-host>:5380/api/zones/records/get?token=<token>&domain=<domain>
router.get('/:slug/dns', (req: Request, res: Response) => {
  const site = getSite(req.params.slug);
  if (!site) {
    res.status(404).json({ error: 'Site not found' });
    return;
  }
  res.status(200).json(site.dnsRecords);
});

// ── POST /api/sites/:slug/dns — add a DNS record (stub) ──────────────────────
// TODO: replace with Technitium API call
// POST http://<technitium-host>:5380/api/zones/records/add?token=<token>
router.post('/:slug/dns', (req: Request, res: Response) => {
  const site = getSite(req.params.slug);
  if (!site) {
    res.status(404).json({ error: 'Site not found' });
    return;
  }
  const body = req.body as Partial<DnsRecord>;
  if (!body.type || !body.name || !body.value || !body.ttl) {
    res.status(400).json({ error: 'Missing required fields: type, name, value, ttl' });
    return;
  }
  const created: DnsRecord = {
    id: `r-${Date.now()}`,
    type: body.type,
    name: body.name,
    value: body.value,
    ttl: body.ttl,
    ...(body.priority !== undefined ? { priority: body.priority } : {})
  };
  res.status(201).json(created);
});

// ── PUT /api/sites/:slug/dns/:id — update a DNS record (stub) ────────────────
// TODO: replace with Technitium API call
// POST http://<technitium-host>:5380/api/zones/records/update?token=<token>
router.put('/:slug/dns/:id', (req: Request, res: Response) => {
  const site = getSite(req.params.slug);
  if (!site) {
    res.status(404).json({ error: 'Site not found' });
    return;
  }
  const existing = site.dnsRecords.find((r) => r.id === req.params.id);
  if (!existing) {
    res.status(404).json({ error: 'DNS record not found' });
    return;
  }
  const updated: DnsRecord = { ...existing, ...(req.body as Partial<DnsRecord>), id: existing.id };
  res.status(200).json(updated);
});

// ── DELETE /api/sites/:slug/dns/:id — delete a DNS record (stub) ─────────────
// TODO: replace with Technitium API call
// GET http://<technitium-host>:5380/api/zones/records/delete?token=<token>&domain=<domain>&type=<type>&value=<value>
router.delete('/:slug/dns/:id', (req: Request, res: Response) => {
  const site = getSite(req.params.slug);
  if (!site) {
    res.status(404).json({ error: 'Site not found' });
    return;
  }
  const existing = site.dnsRecords.find((r) => r.id === req.params.id);
  if (!existing) {
    res.status(404).json({ error: 'DNS record not found' });
    return;
  }
  res.status(204).send();
});

// ── GET /api/sites/:slug/deployments — deployment history ────────────────────
router.get('/:slug/deployments', async (req: Request, res: Response) => {
  if (useMock) {
    const site = getSite(req.params.slug);
    if (!site) {
      res.status(404).json({ error: 'Site not found' });
      return;
    }
    res.status(200).json(site.deploys);
    return;
  }
  try {
    const client = createCoolifyClient()!;
    const app = await client.getApplication(req.params.slug);
    const deployments = await client.listDeployments(app.uuid);
    const deploys = deployments.map((d) => mapDeploy(d, app.git_branch));
    res.status(200).json(deploys);
  } catch (err) {
    console.warn(`[coolify] GET deployments for ${req.params.slug} failed, falling back to mock:`, (err as Error).message);
    const site = getSite(req.params.slug);
    if (!site) {
      res.status(404).json({ error: 'Site not found' });
      return;
    }
    res.setHeader('x-data-source', 'mock');
    res.status(200).json(site.deploys);
  }
});

// ── POST /api/sites/:slug/deploy — trigger a deploy ──────────────────────────
router.post('/:slug/deploy', async (req: Request, res: Response) => {
  if (useMock) {
    const site = getSite(req.params.slug);
    if (!site) {
      res.status(404).json({ error: 'Site not found' });
      return;
    }
    res.status(202).json({ jobId: `job-${Date.now()}` });
    return;
  }
  try {
    const client = createCoolifyClient()!;
    const result = await client.triggerDeploy(req.params.slug);
    res.status(202).json({ jobId: result.deployment_uuid, status: result.status, message: result.message });
  } catch (err) {
    console.warn(`[coolify] POST /deploy for ${req.params.slug} failed:`, (err as Error).message);
    res.status(502).json({ error: 'Failed to trigger deploy via Coolify' });
  }
});

// ── GET /api/sites/:slug/deployments/:id/log — deploy log lines ───────────────
router.get('/:slug/deployments/:id/log', async (req: Request, res: Response) => {
  if (useMock) {
    const site = getSite(req.params.slug);
    if (!site) {
      res.status(404).json({ error: 'Site not found' });
      return;
    }
    const deploy = site.deploys.find((d) => d.id === req.params.id);
    if (!deploy) {
      res.status(404).json({ error: 'Deployment not found' });
      return;
    }
    res.status(200).json(deploy.logLines);
    return;
  }
  try {
    const client = createCoolifyClient()!;
    const deployment = await client.getDeployment(req.params.id);
    const mapped = mapDeploy(deployment, '');
    res.status(200).json(mapped.logLines);
  } catch (err) {
    console.warn(`[coolify] GET deployment log for ${req.params.id} failed, falling back to mock:`, (err as Error).message);
    const site = getSite(req.params.slug);
    if (!site) {
      res.status(404).json({ error: 'Site not found' });
      return;
    }
    const deploy = site.deploys.find((d) => d.id === req.params.id);
    if (!deploy) {
      res.status(404).json({ error: 'Deployment not found' });
      return;
    }
    res.setHeader('x-data-source', 'mock');
    res.status(200).json(deploy.logLines);
  }
});

export default router;
