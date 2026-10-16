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
import { existsSync, readFileSync } from 'fs';
import * as path from 'path';
import { dockerGet } from './docker';
import { resolveRouteDomain } from './mapper';
import { createCoolifyClient, CoolifyApplication, CoolifyClient } from './coolify';
import {
  coolifyNetworkName,
  pickPrimaryComposeService,
  provisionTraefikRoute,
  provisionTraefikRouteForCompose,
  stableSiteRouteAlias,
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
    labels = [`coolify.name=${app.uuid}`];
  }
  const filter = encodeURIComponent(JSON.stringify({ label: labels, status: ['running'] }));
  const containers = await dockerGet(`/containers/json?filters=${filter}`) as ContainerSummary[];
  if (!containers.length) return null;
  return [...containers].sort((a, b) => b.Created - a.Created)[0];
}

async function routeIssues(slug: string, containerId: string, confDir: string): Promise<string[]> {
  const issues: string[] = [];
  const alias = stableSiteRouteAlias(slug);
  const network = coolifyNetworkName();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Docker inspect response shape
  const inspected = await dockerGet(`/containers/${containerId}/json`) as any;
  const endpoint = inspected?.NetworkSettings?.Networks?.[network] as { Aliases?: string[] | null } | undefined;
  if (!endpoint) issues.push(`container not on ${network}`);
  else if (!(endpoint.Aliases ?? []).includes(alias)) issues.push(`missing alias ${alias} on ${network}`);

  const routeFile = path.join(confDir, `site-${slug}.yml`);
  if (!existsSync(routeFile)) {
    issues.push('route file missing');
  } else if (!readFileSync(routeFile, 'utf8').includes(`url: "http://${alias}:`)) {
    issues.push('route does not target stable alias');
  }
  return issues;
}

export async function reconcileSite(
  client: CoolifyClient,
  app: CoolifyApplication,
  confDir: string,
  resolver: 'letsencrypt' | 'internal-ca',
): Promise<ReconcileOutcome> {
  const slug = app.uuid;
  const domain = resolveRouteDomain(app);
  if (!domain) return { slug, status: 'skipped', reason: 'no domain' };

  const container = await findSiteContainer(app);
  if (container === 'no-compose') return { slug, status: 'skipped', reason: 'compose not parsed yet' };
  // A stopped site is left alone — there is nothing to route to.
  if (!container) return { slug, status: 'skipped', reason: 'no running container' };

  const issues = await routeIssues(slug, container.Id, confDir);
  if (!issues.length) return { slug, status: 'healthy' };

  const result = app.build_pack === 'dockercompose'
    ? await provisionTraefikRouteForCompose(client, app, domain, resolver)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ports_exposes is not in the typed payload
    : await provisionTraefikRoute(slug, domain, (app as any).ports_exposes ?? 3000, resolver);
  return result.ok
    ? { slug, status: 'healed', issues }
    : { slug, status: 'failed', issues, reason: result.reason };
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

export function startRouteReconciler(): void {
  const intervalMs = Number(process.env.ROUTE_RECONCILE_INTERVAL_MS ?? 60_000);
  void reconcileAllSites();
  if (intervalMs > 0) {
    setInterval(() => { void reconcileAllSites(); }, intervalMs).unref();
    console.log(`[route-reconcile] periodic reconcile every ${intervalMs}ms`);
  }
}
