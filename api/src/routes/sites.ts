import { Router, Request, Response } from 'express';
import { SITES, getSite, addSite, removeSite, updateSite, DnsRecord } from '../data/mock';
import {
  createCoolifyClient,
  CoolifyCreateApplicationPayload,
  CoolifyUpdateApplicationPayload,
} from '../services/coolify';
import { mapSite, mapDeploy } from '../services/mapper';
import { probeSite } from '../services/healthProbe';
import { createDnsProvider, DnsOperationError } from '../services/dns';

const router = Router();

const useCoolifyMock = !process.env.COOLIFY_API_URL;
const dnsProvider = createDnsProvider();

// ── GET /api/sites — list all sites ──────────────────────────────────────────
router.get('/', async (_req: Request, res: Response) => {
  if (useCoolifyMock) {
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
  if (useCoolifyMock) {
    const site = getSite(req.params.slug);
    if (!site) {
      res.status(404).json({ error: 'Site not found' });
      return;
    }
    const probe = site.domain ? await probeSite(site.domain).catch(() => null) : null;
    res.status(200).json(probe ? { ...site, ...probe } : site);
    return;
  }
  try {
    const client = createCoolifyClient()!;
    const app = await client.getApplication(req.params.slug);
    const domain = app.fqdn
      ? app.fqdn.split(',')[0].trim().replace(/^https?:\/\//, '')
      : '';

    const [deployments, probe] = await Promise.all([
      client.listDeployments(app.uuid).catch(() => []),
      domain
        ? probeSite(domain).catch(() => null)
        : Promise.resolve(null),
    ]);

    res.status(200).json(mapSite(app, deployments, probe));
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

// ── POST /api/sites — create a new site ──────────────────────────────────────
router.post('/', async (req: Request, res: Response) => {
  // Mock mode accepts the frontend's simplified shape: name, domain, gitRepo, gitBranch.
  // Coolify mode requires the full CoolifyCreateApplicationPayload fields.
  if (useCoolifyMock) {
    const { name, domain, gitRepo, gitBranch } = req.body as {
      name?: string;
      domain?: string;
      gitRepo?: string;
      gitBranch?: string;
    };
    if (!name || !domain) {
      res.status(400).json({ error: 'Missing required fields: name, domain' });
      return;
    }
    const slug = name.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    const now = new Date().toISOString();
    const newSite = {
      slug,
      name: name.trim(),
      domain: domain.trim(),
      description: '',
      repository: gitRepo?.trim() ?? '',
      server: '',
      overallStatus: 'pending' as const,
      http: { reachable: false, statusCode: null, responseTimeMs: null, checkedAt: now },
      ssl: { valid: false, expiresAt: null, daysUntilExpiry: null, issuer: null, checkedAt: now },
      dns: { resolving: false, propagated: false, checkedAt: now },
      dnsRecords: [],
      deploys: [],
      ...(gitBranch ? {} : {}),
    };
    addSite(newSite);
    res.status(201).json(newSite);
    return;
  }

  const body = req.body as Partial<CoolifyCreateApplicationPayload>;
  if (!body.name || !body.git_repository || !body.git_branch || !body.server_uuid || !body.destination_uuid) {
    res.status(400).json({
      error: 'Missing required fields: name, git_repository, git_branch, server_uuid, destination_uuid',
    });
    return;
  }
  try {
    const client = createCoolifyClient()!;
    const payload: CoolifyCreateApplicationPayload = {
      name: body.name,
      git_repository: body.git_repository,
      git_branch: body.git_branch,
      server_uuid: body.server_uuid,
      destination_uuid: body.destination_uuid,
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.fqdn !== undefined ? { fqdn: body.fqdn } : {}),
      ...(body.build_pack !== undefined ? { build_pack: body.build_pack } : {}),
    };
    const app = await client.createApplication(payload);
    res.status(201).json(mapSite(app, []));
  } catch (err) {
    console.warn('[coolify] POST /applications failed:', (err as Error).message);
    res.status(502).json({ error: 'Failed to create application via Coolify' });
  }
});

// ── DELETE /api/sites/:slug — delete a site ───────────────────────────────────
router.delete('/:slug', async (req: Request, res: Response) => {
  if (useCoolifyMock) {
    const removed = removeSite(req.params.slug);
    if (!removed) {
      res.status(404).json({ error: 'Site not found' });
      return;
    }
    res.status(204).send();
    return;
  }
  try {
    const client = createCoolifyClient()!;
    await client.deleteApplication(req.params.slug);
    res.status(204).send();
  } catch (err) {
    console.warn(`[coolify] DELETE /applications/${req.params.slug} failed:`, (err as Error).message);
    res.status(502).json({ error: 'Failed to delete application via Coolify' });
  }
});

// ── PATCH /api/sites/:slug — update site settings ────────────────────────────
//
// Field alignment: the frontend Settings tab sends Site-typed fields
// (repository, server, description) rather than Coolify API fields
// (git_repository, build_pack, fqdn). Accepting the frontend's field names
// here keeps the frontend decoupled from Coolify internals. In Coolify mode
// we translate: repository → git_repository. The `server` field has no
// Coolify equivalent and is only applied in mock mode.
router.patch('/:slug', async (req: Request, res: Response) => {
  // Accept both frontend Site fields and raw Coolify fields.
  const body = req.body as Partial<CoolifyUpdateApplicationPayload & {
    repository?: string;
    server?: string;
  }>;
  if (Object.keys(body).length === 0) {
    res.status(400).json({ error: 'Request body must include at least one field to update' });
    return;
  }
  if (useCoolifyMock) {
    const site = getSite(req.params.slug);
    if (!site) {
      res.status(404).json({ error: 'Site not found' });
      return;
    }
    const updates: Partial<import('../data/mock').Site> = {};
    if (body.repository !== undefined) updates.repository = body.repository;
    if (body.git_repository !== undefined) updates.repository = body.git_repository;
    if (body.server !== undefined) updates.server = body.server;
    if (body.description !== undefined) updates.description = body.description;
    if (body.name !== undefined) updates.name = body.name;
    const updated = updateSite(req.params.slug, updates);
    res.status(200).json(updated);
    return;
  }
  try {
    const client = createCoolifyClient()!;
    const payload: CoolifyUpdateApplicationPayload = {};
    if (body.name !== undefined) payload.name = body.name;
    if (body.description !== undefined) payload.description = body.description;
    if (body.fqdn !== undefined) payload.fqdn = body.fqdn;
    // Accept frontend 'repository' field and translate to git_repository
    if (body.repository !== undefined) payload.git_repository = body.repository;
    if (body.git_repository !== undefined) payload.git_repository = body.git_repository;
    if (body.git_branch !== undefined) payload.git_branch = body.git_branch;
    if (body.build_pack !== undefined) payload.build_pack = body.build_pack;
    const app = await client.updateApplication(req.params.slug, payload);
    res.status(200).json(mapSite(app, []));
  } catch (err) {
    console.warn(`[coolify] PATCH /applications/${req.params.slug} failed:`, (err as Error).message);
    res.status(502).json({ error: 'Failed to update application via Coolify' });
  }
});

// ── GET /api/sites/:slug/dns — DNS records for a site ────────────────────────
router.get('/:slug/dns', async (req: Request, res: Response) => {
  const site = getSite(req.params.slug);
  if (!site) { res.status(404).json({ error: 'Site not found' }); return; }
  try {
    const records = await dnsProvider.getRecords(site.domain);
    res.status(200).json(records);
  } catch (err) {
    console.warn('[dns] getRecords failed:', err instanceof DnsOperationError ? err.originalCause : err);
    res.status(500).json({ error: 'DNS operation failed' });
  }
});

// ── POST /api/sites/:slug/dns — add a DNS record ─────────────────────────────
router.post('/:slug/dns', async (req: Request, res: Response) => {
  const site = getSite(req.params.slug);
  if (!site) { res.status(404).json({ error: 'Site not found' }); return; }
  const body = req.body as Partial<DnsRecord>;
  if (!body.type || !body.name || !body.value || !body.ttl) {
    res.status(400).json({ error: 'Missing required fields: type, name, value, ttl' });
    return;
  }
  try {
    const record = await dnsProvider.addRecord(site.domain, {
      type: body.type,
      name: body.name,
      value: body.value,
      ttl: body.ttl,
      ...(body.priority !== undefined ? { priority: body.priority } : {}),
    });
    res.status(201).json(record);
  } catch (err) {
    console.warn('[dns] addRecord failed:', err instanceof DnsOperationError ? err.originalCause : err);
    res.status(500).json({ error: 'DNS operation failed' });
  }
});

// ── PUT /api/sites/:slug/dns/:id — update a DNS record ───────────────────────
router.put('/:slug/dns/:id', async (req: Request, res: Response) => {
  const site = getSite(req.params.slug);
  if (!site) { res.status(404).json({ error: 'Site not found' }); return; }
  try {
    const updates = req.body as Partial<Omit<DnsRecord, 'id'>>;
    const record = await dnsProvider.updateRecord(site.domain, req.params.id, updates);
    res.status(200).json(record);
  } catch (err) {
    console.warn('[dns] updateRecord failed:', err instanceof DnsOperationError ? err.originalCause : err);
    res.status(500).json({ error: 'DNS operation failed' });
  }
});

// ── DELETE /api/sites/:slug/dns/:id — delete a DNS record ────────────────────
router.delete('/:slug/dns/:id', async (req: Request, res: Response) => {
  const site = getSite(req.params.slug);
  if (!site) { res.status(404).json({ error: 'Site not found' }); return; }
  try {
    await dnsProvider.deleteRecord(site.domain, req.params.id);
    res.status(204).send();
  } catch (err) {
    console.warn('[dns] deleteRecord failed:', err instanceof DnsOperationError ? err.originalCause : err);
    res.status(500).json({ error: 'DNS operation failed' });
  }
});

// ── GET /api/sites/:slug/deployments — deployment history ────────────────────
router.get('/:slug/deployments', async (req: Request, res: Response) => {
  if (useCoolifyMock) {
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
  if (useCoolifyMock) {
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
  if (useCoolifyMock) {
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
