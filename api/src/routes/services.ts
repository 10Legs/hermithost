import { Router, Request, Response } from 'express';
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'fs';
import * as path from 'path';
import { dockerGet, dockerPost, dockerDelete } from '../services/docker';
import { createCoolifyClient } from '../services/coolify';
import { ServiceContainer, ContainerStatus, ServiceGroup, ServicesResponse, RestoreEvent } from '../types';

const router = Router();

const DATA_DIR = process.env.DATA_DIR ?? '/app/data';
const RESTORE_EVENT_FILE = path.join(DATA_DIR, 'restore-event.json');
const RESTORE_CONTAINERS_FILE = path.join(DATA_DIR, 'restore-containers.json');

// ── Docker container shape (subset) ──────────────────────────────────────────
interface DockerContainer {
  Id: string;
  Names: string[];
  Image: string;
  State: string;
  Status: string;
  Labels: Record<string, string>;
}

function mapStatus(state: string): ContainerStatus {
  switch (state.toLowerCase()) {
    case 'running':    return 'running';
    case 'exited':     return 'exited';
    case 'paused':     return 'paused';
    case 'restarting': return 'restarting';
    case 'dead':       return 'dead';
    default:           return 'stopped';
  }
}

function shortenImage(image: string): string {
  // Strip registry prefix (e.g. ghcr.io/foo/bar:tag → foo/bar:tag)
  return image.replace(/^[^/]+\.[^/]+\//, '');
}

function extractDomain(labels: Record<string, string>): string | null {
  // Prefer caddy_0 label: "https://probablyfine.570n3r.com"
  const caddy = labels['caddy_0'];
  if (caddy) return caddy.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  // Fall back to traefik rule: Host(`domain.com`)
  for (const [key, val] of Object.entries(labels)) {
    if (key.startsWith('traefik.http.routers.') && key.endsWith('.rule')) {
      const m = val.match(/Host\(`([^`]+)`\)/);
      if (m) return m[1];
    }
  }
  return null;
}

function mapContainer(c: DockerContainer, group: ServiceContainer['group']): ServiceContainer {
  return {
    id: c.Id.slice(0, 12),
    name: (c.Names[0] ?? '').replace(/^\//, ''),
    image: shortenImage(c.Image),
    status: mapStatus(c.State),
    state: c.State,
    uptime: c.Status ?? null,
    group,
    siteSlug: c.Labels['coolify.name'] ?? null,
  };
}

// ── Stack grouping ────────────────────────────────────────────────────────────
// Groups hermithost stack containers by logical function using service name.
const STACK_GROUP_MAP: { id: string; name: string; match: (svc: string) => boolean }[] = [
  { id: 'coolify',        name: 'Coolify',          match: s => s.startsWith('coolify') },
  { id: 'hermithost',     name: 'HermitHost',       match: s => s === 'api' || s === 'frontend' },
  { id: 'infrastructure', name: 'Infrastructure',   match: () => true }, // catch-all
];

function groupStackContainers(containers: DockerContainer[]): ServiceGroup[] {
  const groups = new Map<string, ServiceGroup>();
  for (const def of STACK_GROUP_MAP) {
    groups.set(def.id, { id: def.id, name: def.name, domain: null, abandoned: false, containers: [] });
  }
  for (const c of containers) {
    const svcName = c.Labels['com.docker.compose.service'] ?? '';
    const def = STACK_GROUP_MAP.find(d => d.match(svcName)) ?? STACK_GROUP_MAP[STACK_GROUP_MAP.length - 1];
    groups.get(def.id)!.containers.push(mapContainer(c, 'hermithost-stack'));
  }
  return Array.from(groups.values()).filter(g => g.containers.length > 0);
}

// Known Coolify infrastructure container names — spawned by Coolify's management
// process (not via docker compose) so they lack com.docker.compose.project=coolify.
// They carry coolify.managed=true but are not user-deployed applications.
const COOLIFY_INFRA_NAMES = new Set([
  'coolify-proxy',
  'coolify-sentinel',
  'coolify-server-setup',
]);

// ── Site grouping ─────────────────────────────────────────────────────────────
// A site group is "abandoned" if:
//   - container has no coolify.applicationId label, OR
//   - coolify.resourceName is absent, OR
//   - the applicationId is not found in the live Coolify application list
//     (i.e. the app was deleted in Coolify but the container was not cleaned up)
//
// Filtering strategy:
//   - Docker query uses coolify.applicationId label — only deployed app containers
//     carry this label, excluding infra containers (proxy, sentinel) by default.
//   - Belt-and-suspenders: also exclude by compose project and known infra names
//     in case labels vary across Coolify versions.
function groupBySite(containers: DockerContainer[], liveAppIds: Set<string> | null): ServiceGroup[] {
  const groups = new Map<string, ServiceGroup>();
  for (const c of containers) {
    // Skip hermithost stack containers — appear in Stack Services already
    if (c.Labels['com.docker.compose.project'] === 'hermithost') continue;
    // Skip Coolify's own compose-managed infrastructure
    if (c.Labels['com.docker.compose.project'] === 'coolify') continue;
    // Skip known Coolify infra containers spawned outside compose
    const name = (c.Names[0] ?? '').replace(/^\//, '');
    if (COOLIFY_INFRA_NAMES.has(name)) continue;

    const slug = c.Labels['coolify.name'] ?? c.Id.slice(0, 12);
    const resourceName = c.Labels['coolify.resourceName'];
    // appId is guaranteed non-null — Docker sitesFilter requires coolify.applicationId
    const appId = c.Labels['coolify.applicationId']!;
    const siteName = resourceName ?? slug;
    // Abandoned: app no longer exists in live Coolify app list.
    // coolify.resourceName is a display hint only — its absence does not mean abandoned.
    // When Coolify is unreachable (liveAppIds=null), skip cross-check to avoid false positives.
    const abandoned = liveAppIds !== null && !liveAppIds.has(appId);
    if (abandoned && process.env.DEBUG_SERVICES === 'true') {
      console.log(`[services:debug] marking abandoned: ${name} (appId=${appId}, inLiveList=${liveAppIds?.has(appId) ?? 'n/a'})`);
    }
    if (!groups.has(slug)) {
      groups.set(slug, { id: slug, name: siteName, domain: extractDomain(c.Labels), abandoned, containers: [] });
    }
    groups.get(slug)!.containers.push(mapContainer(c, 'deployed-sites'));
  }
  return Array.from(groups.values());
}

function readAndClearRestoreEvent(): RestoreEvent | null {
  try {
    if (!existsSync(RESTORE_EVENT_FILE)) return null;
    const raw = readFileSync(RESTORE_EVENT_FILE, 'utf8');
    const event = JSON.parse(raw) as RestoreEvent;
    unlinkSync(RESTORE_EVENT_FILE);
    return event;
  } catch {
    return null;
  }
}

// ── GET /api/services — list all containers in both groups ───────────────────
router.get('/', async (_req: Request, res: Response) => {
  try {
    const stackFilter = encodeURIComponent(JSON.stringify({ label: ['com.docker.compose.project=hermithost'] }));
    // Filter by coolify.applicationId — only deployed app containers carry this label.
    // Infrastructure containers (coolify-proxy, coolify-sentinel) do not, so they're
    // excluded at the Docker API level before any application-level filtering.
    const sitesFilter = encodeURIComponent(JSON.stringify({ label: ['coolify.applicationId'] }));

    // Fetch Docker containers and live Coolify app list in parallel.
    // If Coolify is unreachable, liveAppIds is null — fall back to label-only detection.
    const coolify = createCoolifyClient();
    const [stackRaw, sitesRaw, coolifyApps] = await Promise.all([
      dockerGet(`/containers/json?all=true&filters=${stackFilter}`) as Promise<DockerContainer[]>,
      dockerGet(`/containers/json?all=true&filters=${sitesFilter}`) as Promise<DockerContainer[]>,
      coolify ? coolify.listApplications().catch(() => null) : Promise.resolve(null),
    ]);

    // null = Coolify unreachable; skip UUID cross-check to avoid false positives
    const liveAppIds: Set<string> | null = coolifyApps ? new Set(coolifyApps.map(a => a.uuid)) : null;

    if (process.env.DEBUG_SERVICES === 'true') {
      console.log('[services:debug] liveAppIds:', liveAppIds ? [...liveAppIds] : null);
      console.log('[services:debug] sites containers:', sitesRaw.map(c => ({
        name: (c.Names[0] ?? '').replace(/^\//, ''),
        appId: c.Labels['coolify.applicationId'] ?? '(none)',
        resourceName: c.Labels['coolify.resourceName'] ?? '(none)',
        project: c.Labels['com.docker.compose.project'] ?? '(none)',
      })));
    }

    const response: ServicesResponse = {
      stackGroups: groupStackContainers(stackRaw),
      siteGroups: groupBySite(sitesRaw, liveAppIds),
      restoreEvent: readAndClearRestoreEvent(),
    };
    res.status(200).json(response);
  } catch (err) {
    console.error('[services] GET / failed:', (err as Error).message);
    res.status(502).json({ error: 'Failed to list containers from Docker' });
  }
});

// ── POST /api/services/:id/start ─────────────────────────────────────────────
router.post('/:id/start', async (req: Request, res: Response) => {
  try {
    await dockerPost(`/containers/${req.params.id}/start`);
    res.status(204).send();
  } catch (err) {
    console.error(`[services] start ${req.params.id} failed:`, (err as Error).message);
    res.status(502).json({ error: 'Failed to start container' });
  }
});

// ── POST /api/services/:id/stop ──────────────────────────────────────────────
router.post('/:id/stop', async (req: Request, res: Response) => {
  try {
    await dockerPost(`/containers/${req.params.id}/stop?t=10`);
    res.status(204).send();
  } catch (err) {
    console.error(`[services] stop ${req.params.id} failed:`, (err as Error).message);
    res.status(502).json({ error: 'Failed to stop container' });
  }
});

// ── POST /api/services/:id/restart ───────────────────────────────────────────
router.post('/:id/restart', async (req: Request, res: Response) => {
  try {
    await dockerPost(`/containers/${req.params.id}/restart?t=10`);
    res.status(204).send();
  } catch (err) {
    console.error(`[services] restart ${req.params.id} failed:`, (err as Error).message);
    res.status(502).json({ error: 'Failed to restart container' });
  }
});

// ── DELETE /api/services/:id — remove an abandoned container ─────────────────
// Uses force=true to handle running containers; intended only for abandoned ones.
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    // Force-remove: stops if running, then physically deletes
    await dockerDelete(`/containers/${req.params.id}?force=true`);
    res.status(204).send();
  } catch (err) {
    const msg = (err as Error).message;
    // 404 / "no such container" = already gone — idempotent success
    if (msg.includes('404') || msg.toLowerCase().includes('no such container')) {
      res.status(204).send();
      return;
    }
    console.error(`[services] delete ${req.params.id} failed:`, msg);
    res.status(502).json({ error: msg });
  }
});

// ── POST /api/services/shutdown ──────────────────────────────────────────────
// Stops all coolify-managed containers, writes checkpoint, then shuts down stack.
router.post('/shutdown', async (_req: Request, res: Response) => {
  try {
    // List running coolify-managed containers
    const filter = encodeURIComponent(JSON.stringify({ label: ['coolify.managed=true'], status: ['running'] }));
    const runningContainers = await dockerGet(`/containers/json?filters=${filter}`) as DockerContainer[];

    // Write restore checkpoint
    try {
      mkdirSync(DATA_DIR, { recursive: true });
      const checkpoint = runningContainers.map(c => ({ id: c.Id.slice(0, 12), name: (c.Names[0] ?? '').replace(/^\//, '') }));
      writeFileSync(RESTORE_CONTAINERS_FILE, JSON.stringify(checkpoint, null, 2), 'utf8');
      console.log(`[shutdown] Checkpoint written: ${checkpoint.length} container(s)`);
    } catch (err) {
      console.warn('[shutdown] Failed to write checkpoint:', (err as Error).message);
    }

    // Stop coolify containers
    await Promise.all(runningContainers.map(c => dockerPost(`/containers/${c.Id.slice(0, 12)}/stop?t=10`).catch(() => {})));
    console.log(`[shutdown] Stopped ${runningContainers.length} coolify container(s)`);

    // Respond before self-shutdown
    res.status(202).json({ message: 'Coolify containers stopped. Stack shutting down.', stopped: runningContainers.length });

    // After response flushes, stop the hermithost stack via docker socket
    setTimeout(async () => {
      try {
        const stackFilter = encodeURIComponent(JSON.stringify({ label: ['com.docker.compose.project=hermithost'], status: ['running'] }));
        const stackContainers = await dockerGet(`/containers/json?filters=${stackFilter}`) as DockerContainer[];
        // Stop all except self (api container) last
        const selfName = process.env.HOSTNAME ?? '';
        const others = stackContainers.filter(c => !c.Names.some(n => n.includes('api')));
        const self = stackContainers.filter(c => c.Names.some(n => n.includes('api')));
        await Promise.all(others.map(c => dockerPost(`/containers/${c.Id.slice(0, 12)}/stop?t=10`).catch(() => {})));
        await Promise.all(self.map(c => dockerPost(`/containers/${c.Id.slice(0, 12)}/stop?t=5`).catch(() => {})));
        console.log(`[shutdown] Stack stopped (${stackContainers.length} containers)`);
      } catch (err) {
        console.error('[shutdown] Failed to stop stack:', (err as Error).message);
      }
    }, 1500);

  } catch (err) {
    console.error('[services] shutdown failed:', (err as Error).message);
    res.status(502).json({ error: 'Failed to initiate shutdown' });
  }
});

export default router;
