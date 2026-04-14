import { Router, Request, Response } from 'express';
import { SITES, getSite, DnsRecord } from '../data/mock';

const router = Router();

// GET /api/sites — list all sites with status summary
router.get('/', (_req: Request, res: Response) => {
  // TODO: replace with Coolify API call
  // GET http://localhost:8000/api/v1/applications
  res.status(200).json(SITES);
});

// GET /api/sites/:slug — single site detail
router.get('/:slug', (req: Request, res: Response) => {
  // TODO: replace with Coolify API call
  // GET http://localhost:8000/api/v1/applications/:uuid
  const site = getSite(req.params.slug);
  if (!site) {
    res.status(404).json({ error: 'Site not found' });
    return;
  }
  res.status(200).json(site);
});

// GET /api/sites/:slug/dns — DNS records for a site
router.get('/:slug/dns', (req: Request, res: Response) => {
  // TODO: replace with Technitium API call
  // GET http://<technitium-host>:5380/api/zones/records/get?token=<token>&domain=<domain>
  const site = getSite(req.params.slug);
  if (!site) {
    res.status(404).json({ error: 'Site not found' });
    return;
  }
  res.status(200).json(site.dnsRecords);
});

// POST /api/sites/:slug/dns — add a DNS record (stub)
router.post('/:slug/dns', (req: Request, res: Response) => {
  // TODO: replace with Technitium API call
  // POST http://<technitium-host>:5380/api/zones/records/add?token=<token>
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

// PUT /api/sites/:slug/dns/:id — update a DNS record (stub)
router.put('/:slug/dns/:id', (req: Request, res: Response) => {
  // TODO: replace with Technitium API call
  // POST http://<technitium-host>:5380/api/zones/records/update?token=<token>
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

// DELETE /api/sites/:slug/dns/:id — delete a DNS record (stub)
router.delete('/:slug/dns/:id', (req: Request, res: Response) => {
  // TODO: replace with Technitium API call
  // GET http://<technitium-host>:5380/api/zones/records/delete?token=<token>&domain=<domain>&type=<type>&value=<value>
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

// GET /api/sites/:slug/deployments — deployment history
router.get('/:slug/deployments', (req: Request, res: Response) => {
  // TODO: replace with Coolify API call
  // GET http://localhost:8000/api/v1/applications/:uuid/deployments
  const site = getSite(req.params.slug);
  if (!site) {
    res.status(404).json({ error: 'Site not found' });
    return;
  }
  res.status(200).json(site.deploys);
});

// POST /api/sites/:slug/deploy — trigger a deploy (stub)
router.post('/:slug/deploy', (req: Request, res: Response) => {
  // TODO: replace with Coolify API call
  // POST http://localhost:8000/api/v1/applications/:uuid/start
  const site = getSite(req.params.slug);
  if (!site) {
    res.status(404).json({ error: 'Site not found' });
    return;
  }
  res.status(202).json({ jobId: `job-${Date.now()}` });
});

// GET /api/sites/:slug/deployments/:id/log — deploy log lines (stub)
router.get('/:slug/deployments/:id/log', (req: Request, res: Response) => {
  // TODO: replace with Coolify API call
  // GET http://localhost:8000/api/v1/deployments/:deployment_uuid/logs
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
});

export default router;
