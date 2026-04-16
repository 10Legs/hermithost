import { Router, Request, Response } from 'express';
import { DnsRecord } from '../types';
import {
  createCoolifyClient,
  CoolifyCreateApplicationPayload,
  CoolifyUpdateApplicationPayload,
} from '../services/coolify';
import { mapSite, mapDeploy } from '../services/mapper';
import { probeSite } from '../services/healthProbe';
import { createDnsProvider, DnsOperationError } from '../services/dns';

const router = Router();

const dnsProvider = createDnsProvider();

// ── GET /api/sites — list all sites ──────────────────────────────────────────
router.get('/', async (_req: Request, res: Response) => {
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
    console.error('[coolify] GET /applications failed:', (err as Error).message);
    res.status(502).json({ error: 'Failed to retrieve sites from Coolify' });
  }
});

// ── GET /api/sites/:slug — single site detail ─────────────────────────────────
router.get('/:slug', async (req: Request, res: Response) => {
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
    console.error(`[coolify] GET /applications/${req.params.slug} failed:`, (err as Error).message);
    res.status(502).json({ error: 'Failed to retrieve site from Coolify' });
  }
});

// ── POST /api/sites — create a new site ──────────────────────────────────────
// Requires full Coolify payload: name, git_repository, git_branch, server_uuid, destination_uuid
router.post('/', async (req: Request, res: Response) => {
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
    console.error('[coolify] POST /applications failed:', (err as Error).message);
    res.status(502).json({ error: 'Failed to create application via Coolify' });
  }
});

// ── DELETE /api/sites/:slug — delete a site ───────────────────────────────────
router.delete('/:slug', async (req: Request, res: Response) => {
  try {
    const client = createCoolifyClient()!;
    await client.deleteApplication(req.params.slug);
    res.status(204).send();
  } catch (err) {
    console.error(`[coolify] DELETE /applications/${req.params.slug} failed:`, (err as Error).message);
    res.status(502).json({ error: 'Failed to delete application via Coolify' });
  }
});

// ── PATCH /api/sites/:slug — update site settings ────────────────────────────
//
// Accepts both frontend Site fields (repository, description) and raw Coolify
// fields (git_repository, build_pack, fqdn). repository → git_repository translation
// keeps the frontend decoupled from Coolify internals.
router.patch('/:slug', async (req: Request, res: Response) => {
  const body = req.body as Partial<CoolifyUpdateApplicationPayload & {
    repository?: string;
    server?: string;
  }>;
  if (Object.keys(body).length === 0) {
    res.status(400).json({ error: 'Request body must include at least one field to update' });
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
    console.error(`[coolify] PATCH /applications/${req.params.slug} failed:`, (err as Error).message);
    res.status(502).json({ error: 'Failed to update application via Coolify' });
  }
});

// ── GET /api/sites/:slug/dns — DNS records for a site ────────────────────────
router.get('/:slug/dns', async (req: Request, res: Response) => {
  try {
    const client = createCoolifyClient()!;
    const app = await client.getApplication(req.params.slug);
    const domain = app.fqdn
      ? app.fqdn.split(',')[0].trim().replace(/^https?:\/\//, '')
      : '';
    if (!domain) {
      res.status(422).json({ error: 'Site has no domain configured' });
      return;
    }
    const records = await dnsProvider.getRecords(domain);
    res.status(200).json(records);
  } catch (err) {
    if (err instanceof DnsOperationError) {
      console.warn('[dns] getRecords failed:', err.originalCause);
      res.status(500).json({ error: 'DNS operation failed' });
    } else {
      console.error(`[coolify] GET /applications/${req.params.slug} for DNS failed:`, (err as Error).message);
      res.status(502).json({ error: 'Failed to retrieve site from Coolify' });
    }
  }
});

// ── POST /api/sites/:slug/dns — add a DNS record ─────────────────────────────
router.post('/:slug/dns', async (req: Request, res: Response) => {
  try {
    const client = createCoolifyClient()!;
    const app = await client.getApplication(req.params.slug);
    const domain = app.fqdn
      ? app.fqdn.split(',')[0].trim().replace(/^https?:\/\//, '')
      : '';
    if (!domain) {
      res.status(422).json({ error: 'Site has no domain configured' });
      return;
    }
    const body = req.body as Partial<DnsRecord>;
    if (!body.type || !body.name || !body.value || !body.ttl) {
      res.status(400).json({ error: 'Missing required fields: type, name, value, ttl' });
      return;
    }
    const record = await dnsProvider.addRecord(domain, {
      type: body.type,
      name: body.name,
      value: body.value,
      ttl: body.ttl,
      ...(body.priority !== undefined ? { priority: body.priority } : {}),
    });
    res.status(201).json(record);
  } catch (err) {
    if (err instanceof DnsOperationError) {
      console.warn('[dns] addRecord failed:', err.originalCause);
      res.status(500).json({ error: 'DNS operation failed' });
    } else {
      console.error(`[coolify] GET /applications/${req.params.slug} for DNS failed:`, (err as Error).message);
      res.status(502).json({ error: 'Failed to retrieve site from Coolify' });
    }
  }
});

// ── PUT /api/sites/:slug/dns/:id — update a DNS record ───────────────────────
router.put('/:slug/dns/:id', async (req: Request, res: Response) => {
  try {
    const client = createCoolifyClient()!;
    const app = await client.getApplication(req.params.slug);
    const domain = app.fqdn
      ? app.fqdn.split(',')[0].trim().replace(/^https?:\/\//, '')
      : '';
    if (!domain) {
      res.status(422).json({ error: 'Site has no domain configured' });
      return;
    }
    const updates = req.body as Partial<Omit<DnsRecord, 'id'>>;
    const record = await dnsProvider.updateRecord(domain, req.params.id, updates);
    res.status(200).json(record);
  } catch (err) {
    if (err instanceof DnsOperationError) {
      console.warn('[dns] updateRecord failed:', err.originalCause);
      res.status(500).json({ error: 'DNS operation failed' });
    } else {
      console.error(`[coolify] GET /applications/${req.params.slug} for DNS failed:`, (err as Error).message);
      res.status(502).json({ error: 'Failed to retrieve site from Coolify' });
    }
  }
});

// ── DELETE /api/sites/:slug/dns/:id — delete a DNS record ────────────────────
router.delete('/:slug/dns/:id', async (req: Request, res: Response) => {
  try {
    const client = createCoolifyClient()!;
    const app = await client.getApplication(req.params.slug);
    const domain = app.fqdn
      ? app.fqdn.split(',')[0].trim().replace(/^https?:\/\//, '')
      : '';
    if (!domain) {
      res.status(422).json({ error: 'Site has no domain configured' });
      return;
    }
    await dnsProvider.deleteRecord(domain, req.params.id);
    res.status(204).send();
  } catch (err) {
    if (err instanceof DnsOperationError) {
      console.warn('[dns] deleteRecord failed:', err.originalCause);
      res.status(500).json({ error: 'DNS operation failed' });
    } else {
      console.error(`[coolify] GET /applications/${req.params.slug} for DNS failed:`, (err as Error).message);
      res.status(502).json({ error: 'Failed to retrieve site from Coolify' });
    }
  }
});

// ── GET /api/sites/:slug/deployments — deployment history ────────────────────
router.get('/:slug/deployments', async (req: Request, res: Response) => {
  try {
    const client = createCoolifyClient()!;
    const app = await client.getApplication(req.params.slug);
    const deployments = await client.listDeployments(app.uuid);
    const deploys = deployments.map((d) => mapDeploy(d, app.git_branch));
    res.status(200).json(deploys);
  } catch (err) {
    console.error(`[coolify] GET deployments for ${req.params.slug} failed:`, (err as Error).message);
    res.status(502).json({ error: 'Failed to retrieve deployments from Coolify' });
  }
});

// ── POST /api/sites/:slug/deploy — trigger a deploy ──────────────────────────
router.post('/:slug/deploy', async (req: Request, res: Response) => {
  try {
    const client = createCoolifyClient()!;
    const result = await client.triggerDeploy(req.params.slug);
    res.status(202).json({ jobId: result.deployment_uuid, status: result.status, message: result.message });
  } catch (err) {
    console.error(`[coolify] POST /deploy for ${req.params.slug} failed:`, (err as Error).message);
    res.status(502).json({ error: 'Failed to trigger deploy via Coolify' });
  }
});

// ── GET /api/sites/:slug/deployments/:id/log — deploy log lines ───────────────
router.get('/:slug/deployments/:id/log', async (req: Request, res: Response) => {
  try {
    const client = createCoolifyClient()!;
    const deployment = await client.getDeployment(req.params.id);
    const mapped = mapDeploy(deployment, '');
    res.status(200).json(mapped.logLines);
  } catch (err) {
    console.error(`[coolify] GET deployment log for ${req.params.id} failed:`, (err as Error).message);
    res.status(502).json({ error: 'Failed to retrieve deployment log from Coolify' });
  }
});

export default router;
