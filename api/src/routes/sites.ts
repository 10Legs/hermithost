import { Router, Request, Response } from 'express';
import { readFileSync, writeFileSync, unlinkSync } from 'fs';
import * as path from 'path';
import { dockerGet, dockerPost } from '../services/docker';
import { DnsRecord } from '../types';
import {
  createCoolifyClient,
  CoolifyCreateApplicationPayload,
  CoolifyUpdateApplicationPayload,
  CoolifyEnv,
  CreateEnvPayload,
  UpdateEnvPayload,
} from '../services/coolify';
import { mapSite, mapDeploy } from '../services/mapper';
import { probeSite } from '../services/healthProbe';
import { createDnsProvider, DnsOperationError } from '../services/dns';
import { createTechnitiumClient, TechnitiumClient } from '../services/technitium';
import { readNsHostname, readNsServerIp, readNetworkMode } from './config';

const router = Router();

// ── Deploy auth sidecar ───────────────────────────────────────────────────────
// Coolify may strip embedded PAT credentials from stored git_repository URLs,
// making URL-based auth detection unreliable after page refresh.
// We persist deploy_auth to a small sidecar file so it survives across requests.
const SITES_DIR = process.env.SITES_DIR ?? '/app/sites';

function readStoredDeployAuth(uuid: string): 'ssh_key' | 'pat' | null {
  try {
    const { mkdirSync } = require('fs') as typeof import('fs');
    mkdirSync(SITES_DIR, { recursive: true });
    const val = readFileSync(path.join(SITES_DIR, `${uuid}.auth`), 'utf8').trim();
    if (val === 'pat' || val === 'ssh_key') return val;
  } catch { /* not stored yet */ }
  return null;
}

function writeStoredDeployAuth(uuid: string, auth: 'ssh_key' | 'pat'): void {
  try {
    const { mkdirSync } = require('fs') as typeof import('fs');
    mkdirSync(SITES_DIR, { recursive: true });
    writeFileSync(path.join(SITES_DIR, `${uuid}.auth`), auth, 'utf8');
  } catch (err) {
    console.warn(`[deploy-auth] Could not write auth sidecar for ${uuid}:`, (err as Error).message);
  }
}

// ── Visibility sidecar (Option C stub) ────────────────────────────────────────
// Persists per-site visibility so Option C (dual-mode) can be added without
// changing site creation logic. Default matches current network_mode.
// Values now: 'internal' | 'external'. Option C adds: 'both'.
function readStoredVisibility(uuid: string): 'internal' | 'external' {
  try {
    const { mkdirSync: _mkdir } = require('fs') as typeof import('fs');
    _mkdir(SITES_DIR, { recursive: true });
    const val = readFileSync(path.join(SITES_DIR, `${uuid}.visibility`), 'utf8').trim();
    if (val === 'internal' || val === 'external') return val;
  } catch { /* not stored yet — fall through to default */ }
  return readNetworkMode() === 'internal' ? 'internal' : 'external';
}

function writeStoredVisibility(uuid: string, visibility: 'internal' | 'external'): void {
  try {
    const { mkdirSync: _mkdir } = require('fs') as typeof import('fs');
    _mkdir(SITES_DIR, { recursive: true });
    writeFileSync(path.join(SITES_DIR, `${uuid}.visibility`), visibility, 'utf8');
  } catch (err) {
    console.warn(`[visibility] Could not write visibility sidecar for ${uuid}:`, (err as Error).message);
  }
}

// ── Disabled state sidecar ────────────────────────────────────────────────────
// Persists per-site disabled flag as a presence file: {uuid}.disabled exists → site is disabled.
function readDisabledState(uuid: string): boolean {
  try {
    const { mkdirSync: _mkdir, existsSync } = require('fs') as typeof import('fs');
    _mkdir(SITES_DIR, { recursive: true });
    return existsSync(path.join(SITES_DIR, `${uuid}.disabled`));
  } catch { return false; }
}

function writeDisabledState(uuid: string, disabled: boolean): void {
  try {
    const { mkdirSync: _mkdir, unlinkSync: _unlink } = require('fs') as typeof import('fs');
    _mkdir(SITES_DIR, { recursive: true });
    const filePath = path.join(SITES_DIR, `${uuid}.disabled`);
    if (disabled) {
      writeFileSync(filePath, 'true', 'utf8');
    } else {
      try { _unlink(filePath); } catch { /* already gone */ }
    }
  } catch (err) {
    console.warn(`[disabled-state] Could not write disabled sidecar for ${uuid}:`, (err as Error).message);
  }
}

function mapSiteWithStoredAuth(
  app: Parameters<typeof mapSite>[0],
  deployments: Parameters<typeof mapSite>[1],
  probe?: Parameters<typeof mapSite>[2]
): ReturnType<typeof mapSite> {
  const site = mapSite(app, deployments, probe ?? null);
  const stored = readStoredDeployAuth(app.uuid);
  if (stored) site.deploy_auth = stored;
  const disabled = readDisabledState(app.uuid);
  if (disabled) {
    site.disabled = true;
    site.overallStatus = 'disabled';
  }
  return site;
}

// ── DNS auto-provisioning ─────────────────────────────────────────────────────
// Creates a zone + A record for the given domain pointing at NS_SERVER_IP.
// In internal mode: uses Technitium directly; zone is under .hh TLD.
// Non-fatal: logs warnings but never throws — site ops should not fail due to DNS.
export async function provisionDns(fqdn: string): Promise<void> {
  const serverIp = readNsServerIp();
  if (!serverIp) {
    console.warn('[dns-provision] NS_SERVER_IP not set — skipping DNS provisioning');
    return;
  }
  // Strip protocol and trailing slashes to get bare domain
  const domain = fqdn.replace(/^https?:\/\//, '').replace(/\/.*$/, '').trim();
  if (!domain) return;

  const isInternal = readNetworkMode() === 'internal';

  if (isInternal) {
    // Internal mode: always use Technitium; ensure .hh root zone exists first
    const technitium = createTechnitiumClient();
    if (!technitium) {
      console.warn('[dns-provision] Technitium not configured — skipping internal DNS provisioning');
      return;
    }
    // Ensure .hh root zone exists (idempotent)
    try {
      await technitium.createZone('hh', 'Primary');
      console.log('[dns-provision] .hh root zone ensured');
    } catch (err) {
      const msg = (err as Error).message ?? '';
      if (!msg.toLowerCase().includes('already exists')) {
        console.warn('[dns-provision] .hh root zone create warning:', msg);
      }
    }
    // Create zone for this site (e.g. mysite.hh)
    try {
      await technitium.createZone(domain, 'Primary');
      console.log(`[dns-provision] Internal zone created: ${domain}`);
    } catch (err) {
      const msg = (err as Error).message ?? '';
      if (!msg.toLowerCase().includes('already exists')) {
        console.warn(`[dns-provision] Internal zone create warning for ${domain}:`, msg);
      }
    }
    // Add A record
    try {
      const params = new URLSearchParams();
      params.set('type', 'A');
      params.set('ttl', '3600');
      params.set('ipAddress', serverIp);
      await technitium.addRecord(domain, params);
      console.log(`[dns-provision] Internal A record created: ${domain} → ${serverIp}`);
    } catch (err) {
      console.warn(`[dns-provision] Internal A record warning for ${domain}:`, (err as Error).message);
    }
    return;
  }

  const provider = createDnsProvider();

  try {
    await provider.createZone(domain);
    console.log(`[dns-provision] Zone created: ${domain}`);
  } catch (err) {
    // Zone may already exist — that's fine
    const msg = (err as Error).message ?? '';
    if (!msg.includes('already exists') && !msg.toLowerCase().includes('already exists')) {
      console.warn(`[dns-provision] Zone create warning for ${domain}:`, msg);
    }
  }

  try {
    await provider.addRecord(domain, { type: 'A', name: '@', value: serverIp, ttl: 3600 });
    console.log(`[dns-provision] A record created: ${domain} @ → ${serverIp}`);
  } catch (err) {
    console.warn(`[dns-provision] A record create warning for ${domain}:`, (err as Error).message);
  }
}

// ── DNS glue record provisioning ─────────────────────────────────────────────
// Creates A record: nsHostname → serverIp in the parent zone.
// e.g. ns1.example.com → 1.2.3.4 in the example.com zone.
export async function ensureNsGlueRecords(
  client: TechnitiumClient,
  nsHostname: string,
  serverIp: string
): Promise<void> {
  try {
    const parts = nsHostname.split('.');
    if (parts.length < 2) return;
    const zone = parts.slice(1).join('.');
    try {
      await client.createZone(zone, 'Primary');
    } catch (err) {
      const msg = (err as Error).message ?? '';
      if (!msg.toLowerCase().includes('already exists')) {
        console.warn(`[dns-init] Zone create warning for ${zone}:`, msg);
      }
    }
    const params = new URLSearchParams();
    params.set('type', 'A');
    params.set('ipAddress', serverIp);
    params.set('ttl', '3600');
    await client.addRecord(nsHostname, params);
    console.log(`[dns-init] Glue A record: ${nsHostname} → ${serverIp}`);
  } catch (err) {
    console.warn('[dns-init] ensureNsGlueRecords failed:', (err as Error).message);
  }
}

// ── Bad NS record cleanup ─────────────────────────────────────────────────────
// Removes NS records whose value is a bare label (no dots) — Docker container IDs
// leaked into zones when Technitium dnsServerDomain was not configured.
export async function cleanBadNsRecords(client: TechnitiumClient): Promise<void> {
  try {
    const zones = await client.listZones();
    for (const zone of zones) {
      if (zone.internal || zone.type !== 'Primary') continue;
      const { records } = await client.getRecords(zone.name);
      for (const rec of records) {
        if (rec.type !== 'NS') continue;
        const ns: string = (rec.rData as { nameServer?: string }).nameServer ?? '';
        const bare = ns.replace(/\.$/, '');
        if (!bare.includes('.')) {
          const params = new URLSearchParams();
          params.set('type', 'NS');
          params.set('nameServer', ns);
          await client.deleteRecord(zone.name, params);
          console.log(`[dns-init] Removed bad NS record: ${zone.name} NS ${ns}`);
        }
      }
    }
  } catch (err) {
    console.warn('[dns-init] cleanBadNsRecords failed:', (err as Error).message);
  }
}

// ── GitHub key linking ────────────────────────────────────────────────────────
// Coolify's create API ignores private_key_uuid — link via DB instead.
// Non-fatal: deployment will fail gracefully if key not linked.
export async function linkGithubKey(appUuid: string): Promise<void> {
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

// ── GitHub key unlinking ──────────────────────────────────────────────────────
// Sets private_key_id = NULL in Coolify DB — used when switching to PAT auth.
// Non-fatal: logs warnings but never throws.
export async function unlinkGithubKey(appUuid: string): Promise<void> {
  try {
    const { Client } = require('pg') as typeof import('pg');
    const pg = new Client({
      host: process.env.PGHOST ?? 'coolify-db',
      port: Number(process.env.PGPORT ?? 5432),
      database: process.env.PGDATABASE ?? 'coolify',
      user: process.env.PGUSER ?? 'coolify',
      password: process.env.PGPASSWORD,
    });
    await pg.connect();
    // Clear private_key_id, source_type, AND source_id — source_type = 'App\Models\GithubApp'
    // causes Coolify to route clones through GitHub App flow which double-prefixes the URL.
    // NULL source_type + NULL source_id required: if source_id is non-null with source_type=NULL,
    // Coolify's morphTo eager-loads via the parent query builder with a null ownerKey,
    // generating "WHERE "" = source_id" which is a PostgreSQL syntax error (zero-length identifier).
    await pg.query(
      `UPDATE applications SET private_key_id = NULL, source_type = NULL, source_id = NULL WHERE uuid=$1`,
      [appUuid]
    );
    await pg.end();
    console.log(`[github-key] Unlinked github-deploy key from app ${appUuid}`);
  } catch (err) {
    console.warn(`[github-key] Could not unlink key from app ${appUuid}:`, (err as Error).message);
  }
}

// ── Traefik route provisioning ────────────────────────────────────────────────
// Queries Docker API for the running Coolify container for a given slug,
// then writes (or removes) a Traefik conf.d route file so the site domain
// is proxied to the correct container. Non-fatal.
const TRAEFIK_CONF_DIR = process.env.TRAEFIK_CONF_DIR ?? '/app/traefik-conf.d';

export async function provisionTraefikRoute(
  slug: string,
  domain: string,
  port: number | string = 3000,
  resolver: 'letsencrypt' | 'internal-ca' = 'letsencrypt'
): Promise<void> {
  const confDir = TRAEFIK_CONF_DIR;
  const filePath = path.join(confDir, `site-${slug}.yml`);
  try {
    // Find container with coolify.name=slug label (any state — stopped containers still have valid names)
    const filter = encodeURIComponent(JSON.stringify({ label: [`coolify.name=${slug}`] }));
    const containers = await dockerGet(`/containers/json?all=true&filters=${filter}`) as Array<{ Names: string[] }>;
    if (!containers.length) {
      console.warn(`[traefik-route] No container found for slug ${slug} — route not written`);
      return;
    }
    const containerName = containers[0].Names[0].replace(/^\//, '');
    const yml = `http:
  routers:
    site-${slug}-http:
      rule: "Host(\`${domain}\`)"
      entryPoints:
        - http
      middlewares:
        - redirect-to-https
      service: site-${slug}

    site-${slug}:
      rule: "Host(\`${domain}\`)"
      entryPoints:
        - https
      tls:
        certResolver: ${resolver}
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
        const domain = app.fqdn
          ? app.fqdn.split(',')[0].trim().replace(/^https?:\/\//, '')
          : '';
        const [deployments, probe] = await Promise.all([
          client.listDeployments(app.uuid).catch(() => []),
          domain ? probeSite(domain).catch(() => null) : Promise.resolve(null),
        ]);
        return mapSiteWithStoredAuth(app, deployments, probe);
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

    res.status(200).json(mapSiteWithStoredAuth(app, deployments, probe));
  } catch (err) {
    console.error(`[coolify] GET /applications/${req.params.slug} failed:`, (err as Error).message);
    res.status(502).json({ error: 'Failed to retrieve site from Coolify' });
  }
});

// ── SSH → HTTPS URL conversion ────────────────────────────────────────────────
// Converts git@github.com:owner/repo.git → https://github.com/owner/repo.git
// Required before embedding a PAT — PAT auth uses HTTPS, not SSH transport.
function sshUrlToHttps(url: string): string {
  const m = url.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
  if (m) return `https://${m[1]}/${m[2]}.git`;
  return url;
}

// ── HTTPS / short-form → SSH URL conversion ───────────────────────────────────
// Converts any repo reference to git@github.com:owner/repo.git format.
// Required when using SSH key auth — Coolify needs the SSH transport URL.
function httpsToSshUrl(url: string): string {
  if (/^git@/.test(url)) return url.endsWith('.git') ? url : `${url}.git`;
  try {
    const u = new URL(url.startsWith('http') ? url : `https://github.com/${url}`);
    const path = u.pathname.replace(/^\//, '').replace(/\.git$/, '');
    return `git@${u.host}:${path}.git`;
  } catch {
    // short-form: owner/repo or owner/repo.git
    return `git@github.com:${url.replace(/\.git$/, '')}.git`;
  }
}

// ── Embed PAT into a GitHub HTTPS clone URL ───────────────────────────────────
// Converts https://github.com/org/repo to https://TOKEN@github.com/org/repo.
// Handles SSH-format URLs (git@github.com:...) by converting to HTTPS first.
// Handles URLs that already have auth embedded (idempotent).
export function embedPatInRepoUrl(repoUrl: string, token: string): string {
  // Normalize to a full HTTPS URL first:
  // 1. SSH → HTTPS
  // 2. short-form owner/repo[.git] → https://github.com/owner/repo.git
  // 3. already HTTPS → leave as-is
  let httpsUrl: string;
  if (/^git@/.test(repoUrl)) {
    httpsUrl = sshUrlToHttps(repoUrl);
  } else if (/^https?:\/\//.test(repoUrl)) {
    httpsUrl = repoUrl;
  } else {
    httpsUrl = `https://github.com/${repoUrl.replace(/\.git$/, '')}.git`;
  }
  try {
    const url = new URL(httpsUrl);
    url.username = token;
    url.password = '';
    return url.toString();
  } catch {
    return httpsUrl.replace(/^https?:\/\//, `https://${token}@`);
  }
}

// ── POST /api/sites — create a new site ──────────────────────────────────────
// Accepts: name, git_repository, git_branch, build_pack (default: nixpacks), port (default: 3000)
// deploy_auth: 'ssh_key' (default) | 'pat'
// deploy_token: required when deploy_auth === 'pat'
router.post('/', async (req: Request, res: Response) => {
  const body = req.body as {
    name?: string;
    git_repository?: string;
    git_branch?: string;
    build_pack?: string;
    port?: number | string;
    description?: string;
    fqdn?: string;
    domain?: string;       // alias for fqdn
    deploy_auth?: 'ssh_key' | 'pat';
    deploy_token?: string; // PAT value — only used when deploy_auth === 'pat'
    docker_compose_location?: string;
    base_directory?: string;
  };
  if (!body.name || !body.git_repository || !body.git_branch) {
    res.status(400).json({
      error: 'Missing required fields: name, git_repository, git_branch',
    });
    return;
  }
  const deployAuth = body.deploy_auth ?? 'ssh_key';
  if (deployAuth === 'pat' && !body.deploy_token?.trim()) {
    res.status(400).json({ error: 'deploy_token is required when deploy_auth is pat' });
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

    // Resolve clone URL — embed PAT for pat auth, SSH format for ssh_key
    const resolvedRepoUrl = deployAuth === 'pat'
      ? embedPatInRepoUrl(body.git_repository, body.deploy_token!.trim())
      : httpsToSshUrl(body.git_repository);

    // Resolve fqdn BEFORE creating the app — Coolify v4.3.5 PATCH /applications/{uuid}
    // silently ignores the 'domains' field, but POST /applications/public accepts fqdn at creation time.
    // In internal mode, override domain to ${slug}.hh regardless of user input.
    const nameSlug = body.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const internalDomain = readNetworkMode() === 'internal' ? `${nameSlug}.hh` : null;
    const resolvedFqdn = internalDomain ?? (body.fqdn ?? body.domain);
    // Coolify requires full URL format — add https:// if no protocol present
    const coolifyFqdn = resolvedFqdn
      ? (/^https?:\/\//i.test(resolvedFqdn) ? resolvedFqdn : `https://${resolvedFqdn}`)
      : undefined;

    const payload: CoolifyCreateApplicationPayload = {
      type: deployAuth === 'pat' ? 'public' : 'private',
      name: body.name,
      git_repository: resolvedRepoUrl,
      git_branch: body.git_branch,
      build_pack: body.build_pack ?? 'nixpacks',
      ports_exposes: String(body.port ?? 3000),
      server_uuid,
      destination_uuid,
      project_uuid,
      environment_name: 'production',
      instant_deploy: false,
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.docker_compose_location !== undefined ? { docker_compose_location: body.docker_compose_location } : (body.build_pack === 'dockercompose' ? { docker_compose_location: '/docker-compose.yml' } : {})),
      ...(body.base_directory !== undefined ? { base_directory: body.base_directory } : {}),
      ...(coolifyFqdn ? { domains: coolifyFqdn } : {}),
    };
    let app = await client.createApplication(payload);

    // SSH key auth: link the deploy key via DB
    // PAT auth: clear source_type (Coolify defaults to GithubApp) and re-apply PAT URL
    if (deployAuth !== 'pat') {
      await linkGithubKey(app.uuid);
    } else {
      // unlinkGithubKey sets source_type = NULL so Coolify uses git_repository directly
      await unlinkGithubKey(app.uuid);
      // Re-apply PAT URL after source_type cleared — Coolify may have stripped it
      await client.updateApplication(app.uuid, { git_repository: resolvedRepoUrl }).catch((e: Error) => {
        console.warn(`[coolify] PAT url re-patch failed for ${app.uuid}:`, e.message);
      });
    }

    if (resolvedFqdn) {
      // Verify domain was actually set by Coolify at creation time
      const refreshed = await client.getApplication(app.uuid).catch(() => null);
      if (refreshed) {
        app = refreshed;
        if (!refreshed.fqdn?.includes(resolvedFqdn)) {
          console.warn(`[coolify] domain verification failed for ${app.uuid}: expected ${resolvedFqdn}, got ${refreshed.fqdn}`);
        }
      }
      await provisionDns(resolvedFqdn);
      // Route file written after first deploy (container doesn't exist yet at creation time)
    }
    writeStoredDeployAuth(app.uuid, deployAuth);
    writeStoredVisibility(app.uuid, readNetworkMode() === 'internal' ? 'internal' : 'external');
    res.status(201).json(mapSiteWithStoredAuth(app, []));
  } catch (err) {
    console.error('[coolify] POST /applications/public failed:', (err as Error).message);
    res.status(502).json({ error: 'Failed to create application via Coolify' });
  }
});

// ── DELETE /api/sites/:slug — delete a site ───────────────────────────────────
router.delete('/:slug', async (req: Request, res: Response) => {
  try {
    const client = createCoolifyClient()!;
    // Fetch domain before deleting so we can clean up DNS
    const app = await client.getApplication(req.params.slug).catch(() => null);
    const domain = app?.fqdn
      ? app.fqdn.split(',')[0].trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '')
      : '';

    await client.deleteApplication(req.params.slug);
    removeTraefikRoute(req.params.slug);

    // Non-fatal DNS teardown — delete zone created by provisionDns
    if (domain) {
      const provider = createDnsProvider();
      if (provider) {
        provider.deleteZone(domain).catch((err: unknown) => {
          console.warn(`[dns-teardown] Failed to delete zone ${domain}:`, (err as Error).message);
        });
      }
    }

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
//
// deploy_auth switching: accepts deploy_auth ('ssh_key'|'pat') + deploy_token (required for pat).
// PAT is embedded in Coolify's git_repository transparently — never exposed to the frontend.
// When updating repository URL on a PAT site, the existing PAT is re-embedded automatically.
router.patch('/:slug', async (req: Request, res: Response) => {
  const body = req.body as Partial<CoolifyUpdateApplicationPayload & {
    fqdn?: string;    // alias — maps to domains
    domain?: string;  // alias — maps to domains
    repository?: string;
    server?: string;
    deploy_auth?: 'ssh_key' | 'pat';
    deploy_token?: string;  // required when deploy_auth === 'pat'
    docker_compose_location?: string;
    base_directory?: string;
  }>;
  if (Object.keys(body).length === 0) {
    res.status(400).json({ error: 'Request body must include at least one field to update' });
    return;
  }
  const switchingAuth = body.deploy_auth !== undefined;
  if (switchingAuth && body.deploy_auth === 'pat' && !body.deploy_token?.trim()) {
    res.status(400).json({ error: 'deploy_token required when deploy_auth is pat' });
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
    if (body.git_branch !== undefined) payload.git_branch = body.git_branch;
    if (body.build_pack !== undefined) payload.build_pack = body.build_pack;
    if (body.docker_compose_location !== undefined) payload.docker_compose_location = body.docker_compose_location;
    if (body.base_directory !== undefined) payload.base_directory = body.base_directory;

    // Auth-aware repository URL handling:
    // - Always stores clean base URL in the frontend-facing Site response
    // - Transparently re-embeds PAT in Coolify's git_repository when needed
    const incomingRepo = (body as any).repository ?? body.git_repository;
    const needCurrentApp = switchingAuth || incomingRepo !== undefined;
    const currentApp = needCurrentApp ? await client.getApplication(req.params.slug) : null;

    // Extract current PAT from Coolify (if site currently uses PAT auth)
    let currentPat: string | null = null;
    if (currentApp) {
      try {
        const url = new URL(currentApp.git_repository);
        if (url.username) currentPat = url.username;
      } catch { /* not a URL */ }
    }

    if (incomingRepo !== undefined || switchingAuth) {
      // Resolve clean base URL from incoming field, or from current Coolify app
      const rawBase = incomingRepo ?? currentApp?.git_repository ?? '';
      let cleanBase: string;
      try {
        const u = new URL(rawBase);
        u.username = '';
        u.password = '';
        cleanBase = u.toString();
      } catch {
        cleanBase = rawBase;
      }

      const effectiveAuth = switchingAuth ? body.deploy_auth! : (currentPat ? 'pat' : 'ssh_key');
      const effectiveToken = (switchingAuth && body.deploy_auth === 'pat')
        ? body.deploy_token!.trim()
        : currentPat;

      payload.git_repository = (effectiveAuth === 'pat' && effectiveToken)
        ? embedPatInRepoUrl(cleanBase, effectiveToken)
        : httpsToSshUrl(cleanBase);
    }

    let app = await client.updateApplication(req.params.slug, payload);

    // Refetch to ensure git_repository is updated (especially for auth switches)
    const refreshed = await client.getApplication(req.params.slug).catch(() => null);
    if (refreshed) app = refreshed;

    // Post-update auth side effects (link/unlink SSH deploy key)
    if (switchingAuth) {
      if (body.deploy_auth === 'pat') {
        await unlinkGithubKey(req.params.slug);
      } else {
        await linkGithubKey(req.params.slug);
      }
    }

    if (payload.domains) {
      await provisionDns(payload.domains);
    }
    // Always attempt Traefik route provision on every PATCH — self-heals sites
    // whose route file was never written (e.g. all prior deploys failed).
    // Non-fatal: provisionTraefikRoute logs a warning if no container is running.
    const currentDomain = app.fqdn ? app.fqdn.split(',')[0].trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '') : '';
    if (currentDomain) {
      const port = (app as any).ports_exposes ?? 3000;
      const resolver = readNetworkMode() === 'internal' ? 'internal-ca' : 'letsencrypt';
      await provisionTraefikRoute(req.params.slug, currentDomain, port, resolver);
    }
    if (switchingAuth) writeStoredDeployAuth(req.params.slug, body.deploy_auth!);
    const result = mapSiteWithStoredAuth(app, []);
    res.status(200).json(result);
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

// ── GET /api/sites/:slug/envs — list environment variables ───────────────────
// Values for is_shown_once=true are masked in the response — the real value
// remains in Coolify and is never returned by this endpoint.
router.get('/:slug/envs', async (req: Request, res: Response) => {
  try {
    const client = createCoolifyClient()!;
    const app = await client.getApplication(req.params.slug);
    const envs = await client.listEnvs(app.uuid);
    const masked = envs.map((env: CoolifyEnv) => ({
      ...env,
      value: env.is_shown_once ? '••••••••' : env.value,
    }));
    res.status(200).json(masked);
  } catch (err) {
    console.error(`[coolify] GET /applications/${req.params.slug}/envs failed:`, (err as Error).message);
    res.status(502).json({ error: 'Failed to retrieve environment variables from Coolify' });
  }
});

// ── POST /api/sites/:slug/envs — create an environment variable ───────────────
router.post('/:slug/envs', async (req: Request, res: Response) => {
  const body = req.body as Partial<CreateEnvPayload>;
  if (!body.key || body.value === undefined) {
    res.status(400).json({ error: 'Missing required fields: key, value' });
    return;
  }
  try {
    const client = createCoolifyClient()!;
    const app = await client.getApplication(req.params.slug);
    const existing = await client.listEnvs(app.uuid);
    const match = existing.find((e) => e.key === body.key);
    const payload = {
      key: body.key,
      value: body.value,
      ...(body.is_runtime !== undefined ? { is_runtime: body.is_runtime } : {}),
      ...(body.is_buildtime !== undefined ? { is_buildtime: body.is_buildtime } : {}),
      ...(body.is_shown_once !== undefined ? { is_shown_once: body.is_shown_once } : {}),
    };
    if (match) {
      await client.updateEnv(app.uuid, { uuid: match.uuid, ...payload });
      res.status(200).json({ message: 'Environment variable updated (key already existed)' });
    } else {
      await client.createEnv(app.uuid, payload);
      res.status(201).json({ message: 'Environment variable created' });
    }
  } catch (err) {
    console.error(`[coolify] POST /applications/${req.params.slug}/envs failed:`, (err as Error).message);
    res.status(502).json({ error: 'Failed to create environment variable via Coolify' });
  }
});

// ── PATCH /api/sites/:slug/envs/:envUuid — update an environment variable ─────
router.patch('/:slug/envs/:envUuid', async (req: Request, res: Response) => {
  const body = req.body as Partial<Omit<UpdateEnvPayload, 'uuid'>>;
  if (!body.key || body.value === undefined) {
    res.status(400).json({ error: 'Missing required fields: key, value' });
    return;
  }
  try {
    const client = createCoolifyClient()!;
    const app = await client.getApplication(req.params.slug);
    await client.updateEnv(app.uuid, {
      uuid: req.params.envUuid,
      key: body.key,
      value: body.value,
      ...(body.is_runtime !== undefined ? { is_runtime: body.is_runtime } : {}),
      ...(body.is_buildtime !== undefined ? { is_buildtime: body.is_buildtime } : {}),
      ...(body.is_shown_once !== undefined ? { is_shown_once: body.is_shown_once } : {}),
    });
    res.status(200).json({ message: 'Environment variable updated' });
  } catch (err) {
    console.error(`[coolify] PATCH /applications/${req.params.slug}/envs/${req.params.envUuid} failed:`, (err as Error).message);
    res.status(502).json({ error: 'Failed to update environment variable via Coolify' });
  }
});

// ── DELETE /api/sites/:slug/envs/:envUuid — delete an environment variable ────
router.delete('/:slug/envs/:envUuid', async (req: Request, res: Response) => {
  try {
    const client = createCoolifyClient()!;
    const app = await client.getApplication(req.params.slug);
    await client.deleteEnv(app.uuid, req.params.envUuid);
    res.status(204).send();
  } catch (err) {
    console.error(`[coolify] DELETE /applications/${req.params.slug}/envs/${req.params.envUuid} failed:`, (err as Error).message);
    res.status(502).json({ error: 'Failed to delete environment variable via Coolify' });
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

// ── POST /api/sites/:slug/disable — stop containers and persist disabled flag ─
router.post('/:slug/disable', async (req: Request, res: Response) => {
  const slug = req.params.slug;
  try {
    const filter = encodeURIComponent(JSON.stringify({ label: [`coolify.name=${slug}`] }));
    const containers = await dockerGet(`/containers/json?all=true&filters=${filter}`) as Array<{ Id: string }>;
    let count = 0;
    for (const container of containers) {
      try {
        await dockerPost(`/containers/${container.Id}/stop?t=10`);
      } catch (err) {
        console.error(`[docker] disable: stop ${container.Id} failed (may already be stopped):`, (err as Error).message);
      }
      try {
        await dockerPost(`/containers/${container.Id}/update`, { RestartPolicy: { Name: 'no' } });
      } catch (err) {
        console.error(`[docker] disable: update restart policy ${container.Id} failed:`, (err as Error).message);
      }
      count++;
    }
    writeDisabledState(slug, true);
    res.status(200).json({ disabled: true, containersStop: count });
  } catch (err) {
    console.error(`[docker] POST /disable for ${slug} failed:`, (err as Error).message);
    res.status(502).json({ error: 'Failed to disable site via Docker' });
  }
});

// ── POST /api/sites/:slug/enable — restore containers and clear disabled flag ─
router.post('/:slug/enable', async (req: Request, res: Response) => {
  const slug = req.params.slug;
  try {
    if (!readDisabledState(slug)) {
      res.status(200).json({ disabled: false });
      return;
    }
    const filter = encodeURIComponent(JSON.stringify({ label: [`coolify.name=${slug}`] }));
    const containers = await dockerGet(`/containers/json?all=true&filters=${filter}`) as Array<{ Id: string }>;
    let count = 0;
    for (const container of containers) {
      try {
        await dockerPost(`/containers/${container.Id}/update`, { RestartPolicy: { Name: 'unless-stopped' } });
      } catch (err) {
        console.error(`[docker] enable: update restart policy ${container.Id} failed:`, (err as Error).message);
      }
      try {
        await dockerPost(`/containers/${container.Id}/start`);
      } catch (err) {
        console.error(`[docker] enable: start ${container.Id} failed (may already be running):`, (err as Error).message);
      }
      count++;
    }
    writeDisabledState(slug, false);
    res.status(200).json({ disabled: false, containersStarted: count });
  } catch (err) {
    console.error(`[docker] POST /enable for ${slug} failed:`, (err as Error).message);
    res.status(502).json({ error: 'Failed to enable site via Docker' });
  }
});

// ── POST /api/sites/:slug/deploy — trigger a deploy ──────────────────────────
router.post('/:slug/deploy', async (req: Request, res: Response) => {
  try {
    if (readDisabledState(req.params.slug)) {
      res.status(409).json({ error: 'Site is disabled. Enable it before deploying.' });
      return;
    }
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
              const resolver = readNetworkMode() === 'internal' ? 'internal-ca' : 'letsencrypt';
              await provisionTraefikRoute(slug, domain, port, resolver);
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
