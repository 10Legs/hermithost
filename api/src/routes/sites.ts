import { Router, Request, Response } from 'express';
import { readFileSync, writeFileSync, unlinkSync } from 'fs';
import * as http from 'http';
import * as path from 'path';
import { DnsRecord } from '../types';
import {
  createCoolifyClient,
  CoolifyCreateApplicationPayload,
  CoolifyUpdateApplicationPayload,
} from '../services/coolify';
import { mapSite, mapDeploy } from '../services/mapper';
import { probeSite } from '../services/healthProbe';
import { createDnsProvider, DnsOperationError } from '../services/dns';
import { createTechnitiumClient } from '../services/technitium';

const router = Router();

// ── DNS auto-provisioning ─────────────────────────────────────────────────────
// Creates a zone + A record for the given domain pointing at NS_HOSTNAME.
// Non-fatal: logs warnings but never throws — site ops should not fail due to DNS.
async function provisionDns(fqdn: string): Promise<void> {
  const serverIp = process.env.NS_HOSTNAME;
  if (!serverIp) {
    console.warn('[dns-provision] NS_HOSTNAME not set — skipping DNS provisioning');
    return;
  }
  // Strip protocol and trailing slashes to get bare domain
  const domain = fqdn.replace(/^https?:\/\//, '').replace(/\/.*$/, '').trim();
  if (!domain) return;

  const client = createTechnitiumClient();
  if (!client) {
    console.warn('[dns-provision] Technitium not configured — skipping DNS provisioning');
    return;
  }

  try {
    await client.createZone(domain, 'Primary');
    console.log(`[dns-provision] Zone created: ${domain}`);
  } catch (err) {
    // Zone may already exist — that's fine
    const msg = (err as Error).message ?? '';
    if (!msg.includes('already exists') && !msg.toLowerCase().includes('already exists')) {
      console.warn(`[dns-provision] Zone create warning for ${domain}:`, msg);
    }
  }

  try {
    const params = new URLSearchParams();
    params.set('type', 'A');
    params.set('ttl', '3600');
    params.set('ipAddress', serverIp);
    await client.addRecord(domain, params);
    console.log(`[dns-provision] A record created: ${domain} @ → ${serverIp}`);
  } catch (err) {
    console.warn(`[dns-provision] A record create warning for ${domain}:`, (err as Error).message);
  }
}

// ── GitHub key linking ────────────────────────────────────────────────────────
// Coolify's create API ignores private_key_uuid — link via DB instead.
// Non-fatal: deployment will fail gracefully if key not linked.
async function linkGithubKey(appUuid: string): Promise<void> {
  try {
    const { readFileSync } = require('fs') as typeof import('fs');
    const keyUuid = readFileSync('/coolify-api-token/github_key_uuid', 'utf8').trim();
    if (!keyUuid) return;
    const { Client } = require('pg') as typeof import('pg');
    const pg = new Client({
      host: process.env.PGHOST ?? 'coolify-db',
      port: Number(process.env.PGPORT ?? 5432),
      database: process.env.PGDATABASE ?? 'coolify',
      user: process.env.PGUSER ?? 'coolify',
      password: process.env.PGPASSWORD,
    });
    await pg.connect();
    await pg.query(
      `UPDATE applications SET private_key_id = (SELECT id FROM private_keys WHERE uuid=$1 LIMIT 1) WHERE uuid=$2`,
      [keyUuid, appUuid]
    );
    await pg.end();
    console.log(`[github-key] Linked github-deploy key to app ${appUuid}`);
  } catch (err) {
    console.warn(`[github-key] Could not link key to app ${appUuid}:`, (err as Error).message);
  }
}

// ── Traefik route provisioning ────────────────────────────────────────────────
// Queries Docker API for the running Coolify container for a given slug,
// then writes (or removes) a Traefik conf.d route file so the site domain
// is proxied to the correct container. Non-fatal.
const TRAEFIK_CONF_DIR = process.env.TRAEFIK_CONF_DIR ?? '/app/traefik-conf.d';

function dockerGet(path: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { socketPath: '/var/run/docker.sock', path, headers: { Host: 'localhost' } },
      (res) => {
        let body = '';
        res.on('data', (d: Buffer) => { body += d; });
        res.on('end', () => {
          try { resolve(JSON.parse(body)); }
          catch { reject(new Error(`Docker API parse error: ${body.slice(0, 200)}`)); }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(3000, () => { req.destroy(); reject(new Error('Docker API timeout')); });
  });
}

async function provisionTraefikRoute(slug: string, domain: string, port: number | string = 3000): Promise<void> {
  const confDir = TRAEFIK_CONF_DIR;
  const filePath = path.join(confDir, `site-${slug}.yml`);
  try {
    // Find running container with coolify.name=slug label
    const filter = encodeURIComponent(JSON.stringify({ label: [`coolify.name=${slug}`] }));
    const containers = await dockerGet(`/containers/json?filters=${filter}`) as Array<{ Names: string[] }>;
    if (!containers.length) {
      console.warn(`[traefik-route] No running container for slug ${slug} — route not written`);
      return;
    }
    const containerName = containers[0].Names[0].replace(/^\//, '');
    const yml = `http:
  routers:
    site-${slug}:
      rule: "Host(\`${domain}\`)"
      entryPoints:
        - http
        - https
      service: site-${slug}

  services:
    site-${slug}:
      loadBalancer:
        servers:
          - url: "http://${containerName}:${port}"
`;
    writeFileSync(filePath, yml, 'utf8');
    console.log(`[traefik-route] Route written for ${domain} → ${containerName}:${port}`);
  } catch (err) {
    console.warn(`[traefik-route] Failed to provision route for ${slug}:`, (err as Error).message);
  }
}

function removeTraefikRoute(slug: string): void {
  try {
    unlinkSync(path.join(TRAEFIK_CONF_DIR, `site-${slug}.yml`));
    console.log(`[traefik-route] Route removed for slug ${slug}`);
  } catch {
    // File may not exist — that's fine
  }
}

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
// Accepts: name, git_repository, git_branch, build_pack (default: nixpacks), port (default: 3000)
router.post('/', async (req: Request, res: Response) => {
  const body = req.body as {
    name?: string;
    git_repository?: string;
    git_branch?: string;
    build_pack?: string;
    port?: number | string;
    description?: string;
    fqdn?: string;
    domain?: string;  // alias for fqdn accepted from frontend
  };
  if (!body.name || !body.git_repository || !body.git_branch) {
    res.status(400).json({
      error: 'Missing required fields: name, git_repository, git_branch',
    });
    return;
  }
  try {
    const client = createCoolifyClient()!;

    // Auto-discover server_uuid
    const servers = await client.getServers();
    if (!servers.length) {
      res.status(502).json({ error: 'No Coolify servers found' });
      return;
    }
    const server_uuid = servers[0].uuid;

    // Auto-discover destination_uuid from file written by coolify-setup.sh
    let destination_uuid: string;
    try {
      destination_uuid = readFileSync('/coolify-api-token/destination_uuid', 'utf8').trim();
    } catch {
      res.status(500).json({ error: 'destination_uuid not available — ensure coolify-setup.sh has run' });
      return;
    }
    if (!destination_uuid) {
      res.status(500).json({ error: 'destination_uuid file is empty — ensure coolify-setup.sh has run' });
      return;
    }

    // Auto-discover or create project
    let projects = await client.getProjects();
    let project_uuid: string;
    if (projects.length > 0) {
      project_uuid = projects[0].uuid;
    } else {
      const created = await client.createProject('hermithost-sites');
      project_uuid = created.uuid;
    }

    const payload: CoolifyCreateApplicationPayload = {
      type: 'public',
      name: body.name,
      git_repository: body.git_repository,
      git_branch: body.git_branch,
      build_pack: body.build_pack ?? 'nixpacks',
      ports_exposes: String(body.port ?? 3000),
      server_uuid,
      destination_uuid,
      project_uuid,
      environment_name: 'production',
      instant_deploy: false,
      ...(body.description !== undefined ? { description: body.description } : {}),
    };
    let app = await client.createApplication(payload);
    await linkGithubKey(app.uuid);

    // fqdn is not accepted at creation time — patch it immediately after using 'domains' field
    const resolvedFqdn = body.fqdn ?? body.domain;
    if (resolvedFqdn) {
      // Coolify requires full URL format — add https:// if no protocol present
      const coolifyDomain = /^https?:\/\//i.test(resolvedFqdn) ? resolvedFqdn : `https://${resolvedFqdn}`;
      await client.updateApplication(app.uuid, { domains: coolifyDomain, force_domain_override: true }).catch((e: Error) => {
        console.warn(`[coolify] domains patch failed for ${app.uuid}:`, e.message);
      });
      // Re-fetch to get full app with updated fqdn
      const refreshed = await client.getApplication(app.uuid).catch(() => null);
      if (refreshed) app = refreshed;
      await provisionDns(resolvedFqdn);
      // Route file written after first deploy (container doesn't exist yet at creation time)
    }
    res.status(201).json(mapSite(app, []));
  } catch (err) {
    console.error('[coolify] POST /applications/public failed:', (err as Error).message);
    res.status(502).json({ error: 'Failed to create application via Coolify' });
  }
});

// ── DELETE /api/sites/:slug — delete a site ───────────────────────────────────
router.delete('/:slug', async (req: Request, res: Response) => {
  try {
    const client = createCoolifyClient()!;
    await client.deleteApplication(req.params.slug);
    removeTraefikRoute(req.params.slug);
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
    fqdn?: string;    // alias — maps to domains
    domain?: string;  // alias — maps to domains
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
    // fqdn/domain → 'domains' (Coolify PATCH field name); requires full URL with protocol
    const incomingFqdn = (body as any).fqdn ?? (body as any).domain ?? body.domains;
    if (incomingFqdn !== undefined) {
      payload.domains = /^https?:\/\//i.test(incomingFqdn) ? incomingFqdn : `https://${incomingFqdn}`;
    }
    // Accept frontend 'repository' field and translate to git_repository
    if ((body as any).repository !== undefined) payload.git_repository = (body as any).repository;
    if (body.git_repository !== undefined) payload.git_repository = body.git_repository;
    if (body.git_branch !== undefined) payload.git_branch = body.git_branch;
    if (body.build_pack !== undefined) payload.build_pack = body.build_pack;
    const app = await client.updateApplication(req.params.slug, payload);
    if (payload.domains) {
      await provisionDns(payload.domains);
      const domain = payload.domains.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
      const port = (app as any).ports_exposes ?? 3000;
      await provisionTraefikRoute(req.params.slug, domain, port);
    }
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
    const records = await createDnsProvider().getRecords(domain);
    res.status(200).json(records);
  } catch (err) {
    if (err instanceof DnsOperationError) {
      const msg = (err.originalCause as Error)?.message ?? '';
      if (msg.includes('No such zone')) {
        res.status(200).json([]);
        return;
      }
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
    const record = await createDnsProvider().addRecord(domain, {
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
    const record = await createDnsProvider().updateRecord(domain, req.params.id, updates);
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
    await createDnsProvider().deleteRecord(domain, req.params.id);
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
    const app = await client.getApplication(req.params.slug);
    const result = await client.triggerDeploy(req.params.slug);
    const dep = result.deployments?.[0];
    res.status(202).json({ jobId: dep?.deployment_uuid, message: dep?.message });

    // Async: update Traefik route once the container is running.
    // Poll up to 3 minutes for the new container to appear.
    if (app.fqdn) {
      const domain = app.fqdn.split(',')[0].trim().replace(/^https?:\/\//, '');
      const port = (app as any).ports_exposes ?? 3000;
      const slug = req.params.slug;
      (async () => {
        const maxAttempts = 18; // 18 × 10s = 3 min
        for (let i = 0; i < maxAttempts; i++) {
          await new Promise(r => setTimeout(r, 10_000));
          try {
            const filter = encodeURIComponent(JSON.stringify({ label: [`coolify.name=${slug}`] }));
            const containers = await dockerGet(`/containers/json?filters=${filter}`) as Array<{ Names: string[]; State: string }>;
            const running = containers.find(c => c.State === 'running');
            if (running) {
              await provisionTraefikRoute(slug, domain, port);
              break;
            }
          } catch {
            // keep polling
          }
        }
      })();
    }
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
