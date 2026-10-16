// ── Site route reconciler ─────────────────────────────────────────────────────
// Keeps every Coolify app reachable through Traefik without waiting for a manual
// deploy/PATCH (#126, #127). For each app with a domain and a running container:
//
//   healthy  = container is on the coolify network with alias site-<slug>
//              AND site-<slug>.yml routes to http://site-<slug>:<port>
//
// Anything else (route file missing, legacy raw-container-name upstream, container
// recreated by Coolify without the alias, container left on the bare `coolify`
// network) is healed by the same provisioning used on deploy. Healthy sites cost
// two Docker API calls and a file read; nothing is rewritten.
//
// Runs once at API startup and then every ROUTE_RECONCILE_INTERVAL_MS
// (default 60s; 0 disables the periodic pass).
//
// Safety: heals run under the same per-site lock as deploy/PATCH/DELETE, on app
// data re-fetched inside the lock; recently deleted sites are never touched; a
// route file containing `hermithost:managed=false` is left alone.
import { existsSync, readFileSync } from 'fs';
import * as path from 'path';
import { dockerGet } from './docker';
import { resolveRouteDomain } from './mapper';
import { createCoolifyClient, CoolifyApplication, CoolifyClient } from './coolify';
import {
  appContainerLabels,
  coolifyNetworkName,
  isSiteRecentlyDeleted,
  pickPrimaryComposeService,
  provisionTraefikRouteUnlocked,
  provisionTraefikRouteForComposeUnlocked,
  stableSiteRouteAlias,
  withSiteRouteLock,
} from '../routes/sites';
import { readNetworkMode } from '../routes/config';

export type ReconcileOutcome =
  | { slug: string; status: 'healthy' }
  | { slug: string; status: 'healed'; issues: string[] }
  | { slug: string; status: 'failed'; issues: string[]; reason?: string }
  | { slug: string; status: 'skipped'; reason: string };

interface ContainerSummary { Id: string; Created: number }

async function findSiteContainer(app: CoolifyApplication): Promise<ContainerSummary | null | 'no-compose'> {
  let labels: string[];
  if (app.build_pack === 'dockercompose') {
    if (!app.docker_compose_raw) return 'no-compose';
    const { primary } = pickPrimaryComposeService(app.docker_compose_raw);
    if (!primary) return 'no-compose';
    labels = [`com.docker.compose.project=${app.uuid}`, `com.docker.compose.service=${primary}`];
  } else {
    labels = appContainerLabels(app.uuid);
  }
  const filter = encodeURIComponent(JSON.stringify({ label: labels, status: ['running'] }));
  const containers = await dockerGet(`/containers/json?filters=${filter}`) as ContainerSummary[];
  if (!containers.length) return null;
  return [...containers].sort((a, b) => b.Created - a.Created)[0];
}

const UNMANAGED_MARKER = 'hermithost:managed=false';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- ports_exposes is not in the typed payload
const nixpacksPort = (app: CoolifyApplication): string => String((app as any).ports_exposes ?? 3000).split(',')[0].trim();

async function routeIssues(
  app: CoolifyApplication,
  domain: string,
  containerId: string,
  confDir: string,
  resolver: 'letsencrypt' | 'internal-ca',
): Promise<string[] | 'unmanaged'> {
  const slug = app.uuid;
  const issues: string[] = [];
  const alias = stableSiteRouteAlias(slug);
  const network = coolifyNetworkName();

  const routeFile = path.join(confDir, `site-${slug}.yml`);
  const route = existsSync(routeFile) ? readFileSync(routeFile, 'utf8') : null;
  if (route?.includes(UNMANAGED_MARKER)) return 'unmanaged';

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Docker inspect response shape
  const inspected = await dockerGet(`/containers/${containerId}/json`) as any;
  const endpoint = inspected?.NetworkSettings?.Networks?.[network] as { Aliases?: string[] | null } | undefined;
  if (!endpoint) issues.push(`container not on ${network}`);
  else if (!(endpoint.Aliases ?? []).includes(alias)) issues.push(`missing alias ${alias} on ${network}`);

  if (route === null) {
    issues.push('route file missing');
  } else {
    // Compose ports are discovered at provision time, so only nixpacks pins the port.
    const upstream = app.build_pack === 'dockercompose' ? `url: "http://${alias}:` : `url: "http://${alias}:${nixpacksPort(app)}"`;
    if (!route.includes(upstream)) issues.push('route does not target stable alias');
    if (!route.includes(`Host(\`${domain}\`)`)) issues.push(`route host is not ${domain}`);
    const tlsOk = resolver === 'internal-ca' ? route.includes('tls: {}') : route.includes(`certResolver: ${resolver}`);
    if (!tlsOk) issues.push(`route TLS is not ${resolver}`);
  }
  return issues;
}

async function check(
  app: CoolifyApplication,
  confDir: string,
  resolver: 'letsencrypt' | 'internal-ca',
): Promise<{ outcome: ReconcileOutcome } | { domain: string; issues: string[] }> {
  const slug = app.uuid;
  if (isSiteRecentlyDeleted(slug)) return { outcome: { slug, status: 'skipped', reason: 'recently deleted' } };
  const domain = resolveRouteDomain(app);
  if (!domain) return { outcome: { slug, status: 'skipped', reason: 'no domain' } };
  const container = await findSiteContainer(app);
  if (container === 'no-compose') return { outcome: { slug, status: 'skipped', reason: 'compose not parsed yet' } };
  // A stopped site is left alone — there is nothing to route to.
  if (!container) return { outcome: { slug, status: 'skipped', reason: 'no running container' } };
  const issues = await routeIssues(app, domain, container.Id, confDir, resolver);
  if (issues === 'unmanaged') return { outcome: { slug, status: 'skipped', reason: 'route marked hermithost:managed=false' } };
  if (!issues.length) return { outcome: { slug, status: 'healthy' } };
  return { domain, issues };
}

export async function reconcileSite(
  client: CoolifyClient,
  app: CoolifyApplication,
  confDir: string,
  resolver: 'letsencrypt' | 'internal-ca',
): Promise<ReconcileOutcome> {
  const slug = app.uuid;
  // Cheap check without the lock: healthy sites never wait on a deploy in progress.
  const first = await check(app, confDir, resolver);
  if ('outcome' in first) return first.outcome;

  return withSiteRouteLock(slug, async () => {
    // Re-check on fresh data under the lock: a DELETE/PATCH/deploy may have run
    // since the app list was fetched.
    let fresh: CoolifyApplication;
    try {
      fresh = await client.getApplication(slug);
    } catch {
      return { slug, status: 'skipped', reason: 'app no longer in Coolify' } as ReconcileOutcome;
    }
    const again = await check(fresh, confDir, resolver);
    if ('outcome' in again) return again.outcome;

    const result = fresh.build_pack === 'dockercompose'
      ? await provisionTraefikRouteForComposeUnlocked(client, fresh, again.domain, resolver)
      : await provisionTraefikRouteUnlocked(slug, again.domain, nixpacksPort(fresh), resolver);
    return result.ok
      ? { slug, status: 'healed', issues: again.issues }
      : { slug, status: 'failed', issues: again.issues, reason: result.reason };
  });
}

let running = false;

export async function reconcileAllSites(): Promise<ReconcileOutcome[]> {
  if (running) return [];
  running = true;
  try {
    const client = createCoolifyClient();
    if (!client) {
      console.warn('[route-reconcile] Coolify client not available — skipping');
      return [];
    }
    const confDir = process.env.TRAEFIK_CONF_DIR ?? '/app/traefik-conf.d';
    const resolver = readNetworkMode() === 'internal' ? 'internal-ca' : 'letsencrypt';
    const applications = await client.listApplications();

    const outcomes: ReconcileOutcome[] = [];
    for (const app of applications) {
      let outcome: ReconcileOutcome;
      try {
        outcome = await reconcileSite(client, app, confDir, resolver);
      } catch (err) {
        outcome = { slug: app.uuid, status: 'failed', issues: [], reason: (err as Error).message };
      }
      if (outcome.status === 'healed') {
        console.log(`[route-reconcile] healed ${outcome.slug}: ${outcome.issues.join('; ')}`);
      } else if (outcome.status === 'failed') {
        console.warn(`[route-reconcile] failed to heal ${outcome.slug}: ${[...outcome.issues, outcome.reason].filter(Boolean).join('; ')}`);
      }
      outcomes.push(outcome);
    }
    return outcomes;
  } catch (err) {
    console.warn('[route-reconcile] pass failed:', (err as Error).message);
    return [];
  } finally {
    running = false;
  }
}

export function reconcileIntervalMs(raw = process.env.ROUTE_RECONCILE_INTERVAL_MS): number {
  if (raw === undefined || raw.trim() === '') return 60_000;
  const ms = Number(raw);
  if (!Number.isFinite(ms) || ms < 0) {
    console.warn(`[route-reconcile] invalid ROUTE_RECONCILE_INTERVAL_MS=${JSON.stringify(raw)} — using 60000`);
    return 60_000;
  }
  return ms;
}

export function startRouteReconciler(): void {
  const intervalMs = reconcileIntervalMs();
  void reconcileAllSites();
  if (intervalMs > 0) {
    setInterval(() => { void reconcileAllSites(); }, intervalMs).unref();
    console.log(`[route-reconcile] periodic reconcile every ${intervalMs}ms`);
  } else {
    console.log('[route-reconcile] periodic reconcile disabled (ROUTE_RECONCILE_INTERVAL_MS=0); startup pass only');
  }
}
