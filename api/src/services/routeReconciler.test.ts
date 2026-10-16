import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';

vi.mock('./docker', () => ({ dockerGet: vi.fn() }));
vi.mock('../routes/sites', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../routes/sites')>();
  return {
    ...actual,
    provisionTraefikRouteUnlocked: vi.fn(),
    provisionTraefikRouteForComposeUnlocked: vi.fn(),
  };
});

import { dockerGet } from './docker';
import {
  buildTraefikRouteYaml,
  markSiteDeleted,
  provisionTraefikRouteForComposeUnlocked,
  provisionTraefikRouteUnlocked,
  withSiteRouteLock,
} from '../routes/sites';
import { reconcileIntervalMs, reconcileSite } from './routeReconciler';
import type { CoolifyApplication, CoolifyClient } from './coolify';

const NET = 'hermithost-coolify';

function nixApp(uuid = 'abc123', extra: Record<string, unknown> = {}): CoolifyApplication {
  return { uuid, build_pack: 'nixpacks', fqdn: `https://${uuid}.example.com`, ports_exposes: '3000', ...extra } as unknown as CoolifyApplication;
}
function composeApp(uuid = 'cmp456'): CoolifyApplication {
  return {
    uuid,
    build_pack: 'dockercompose',
    fqdn: `https://${uuid}.example.com`,
    docker_compose_raw: 'services:\n  db: {image: postgres}\n  app: {image: nginx}\n',
  } as unknown as CoolifyApplication;
}
// Client whose getApplication returns the given app (fresh data under the lock).
function clientFor(app: CoolifyApplication | Error): CoolifyClient {
  return {
    getApplication: vi.fn(async () => { if (app instanceof Error) throw app; return app; }),
  } as unknown as CoolifyClient;
}

function mockDocker(containers: Array<{ Id: string; Created: number }>, networks: Record<string, { Aliases: string[] | null }> = {}) {
  vi.mocked(dockerGet).mockImplementation(async (p: string) => {
    if (p.startsWith('/containers/json')) return containers;
    if (p.endsWith('/json')) return { NetworkSettings: { Networks: networks } };
    throw new Error(`unexpected ${p}`);
  });
}

let confDir: string;
function writeRoute(slug: string, domain: string, upstream: string, resolver: 'letsencrypt' | 'internal-ca' = 'letsencrypt') {
  writeFileSync(path.join(confDir, `site-${slug}.yml`), buildTraefikRouteYaml(slug, domain, upstream, resolver));
}

beforeEach(() => {
  vi.resetAllMocks();
  process.env.COOLIFY_NETWORK_NAME = NET;
  confDir = mkdtempSync(path.join(tmpdir(), 'reconcile-'));
  vi.mocked(provisionTraefikRouteUnlocked).mockResolvedValue({ ok: true });
  vi.mocked(provisionTraefikRouteForComposeUnlocked).mockResolvedValue({ ok: true });
});

describe('reconcileSite', () => {
  it('leaves a healthy site alone without taking the lock or re-fetching', async () => {
    mockDocker([{ Id: 'c1', Created: 1 }], { [NET]: { Aliases: ['site-abc123'] } });
    writeRoute('abc123', 'abc123.example.com', 'site-abc123:3000');
    const client = clientFor(nixApp());
    expect(await reconcileSite(client, nixApp(), confDir, 'letsencrypt')).toEqual({ slug: 'abc123', status: 'healthy' });
    expect(client.getApplication).not.toHaveBeenCalled();
    expect(provisionTraefikRouteUnlocked).not.toHaveBeenCalled();
  });

  it('heals a nixpacks container stranded on the bare coolify network (#127)', async () => {
    mockDocker([{ Id: 'c1', Created: 1 }], { coolify: { Aliases: ['abc123-1'] } });
    writeRoute('abc123', 'abc123.example.com', 'abc123-151051441837:3000');
    const out = await reconcileSite(clientFor(nixApp()), nixApp(), confDir, 'letsencrypt');
    expect(out).toMatchObject({ status: 'healed', issues: [`container not on ${NET}`, 'route does not target stable alias'] });
    expect(provisionTraefikRouteUnlocked).toHaveBeenCalledWith('abc123', 'abc123.example.com', '3000', 'letsencrypt');
  });

  it('heals a container that lost its alias after a Coolify recreate (#126)', async () => {
    mockDocker([{ Id: 'c2', Created: 2 }], { [NET]: { Aliases: null } });
    writeRoute('cmp456', 'cmp456.example.com', 'site-cmp456:80', 'internal-ca');
    const app = composeApp();
    const client = clientFor(app);
    const out = await reconcileSite(client, app, confDir, 'internal-ca');
    expect(out).toMatchObject({ status: 'healed', issues: [`missing alias site-cmp456 on ${NET}`] });
    expect(provisionTraefikRouteForComposeUnlocked).toHaveBeenCalledWith(client, app, 'cmp456.example.com', 'internal-ca');
  });

  it('recreates a missing route file', async () => {
    mockDocker([{ Id: 'c1', Created: 1 }], { [NET]: { Aliases: ['site-abc123'] } });
    const out = await reconcileSite(clientFor(nixApp()), nixApp(), confDir, 'letsencrypt');
    expect(out).toMatchObject({ status: 'healed', issues: ['route file missing'] });
  });

  it('heals a route whose host, port or TLS resolver no longer match the app', async () => {
    mockDocker([{ Id: 'c1', Created: 1 }], { [NET]: { Aliases: ['site-abc123'] } });
    writeRoute('abc123', 'old.example.com', 'site-abc123:8080', 'internal-ca');
    const out = await reconcileSite(clientFor(nixApp()), nixApp(), confDir, 'letsencrypt');
    expect(out).toMatchObject({
      status: 'healed',
      issues: ['route does not target stable alias', 'route host is not abc123.example.com', 'route TLS is not letsencrypt'],
    });
  });

  it('uses fresh app data under the lock (a PATCH changed the domain mid-pass)', async () => {
    mockDocker([{ Id: 'c1', Created: 1 }], { [NET]: { Aliases: ['site-abc123'] } });
    writeRoute('abc123', 'new.example.com', 'site-abc123:3000');
    const stale = nixApp();                                   // listApplications: old domain
    const fresh = nixApp('abc123', { fqdn: 'https://new.example.com' }); // getApplication: PATCHed
    const out = await reconcileSite(clientFor(fresh), stale, confDir, 'letsencrypt');
    expect(out).toEqual({ slug: 'abc123', status: 'healthy' });
    expect(provisionTraefikRouteUnlocked).not.toHaveBeenCalled();
  });

  it('never resurrects the route of a site deleted mid-pass', async () => {
    mockDocker([{ Id: 'c1', Created: 1 }], { [NET]: { Aliases: ['site-gone1'] } });
    const app = nixApp('gone1');
    // Deleted after the list was fetched: Coolify 404s the re-fetch.
    expect(await reconcileSite(clientFor(new Error('404')), app, confDir, 'letsencrypt'))
      .toMatchObject({ status: 'skipped', reason: 'app no longer in Coolify' });
    // Deleted through HermitHost: tombstoned even while the container still runs.
    markSiteDeleted('gone1');
    expect(await reconcileSite(clientFor(app), app, confDir, 'letsencrypt'))
      .toMatchObject({ status: 'skipped', reason: 'recently deleted' });
    expect(provisionTraefikRouteUnlocked).not.toHaveBeenCalled();
  });

  it('waits for an in-flight deploy/PATCH holding the site lock', async () => {
    mockDocker([{ Id: 'c1', Created: 1 }], {});
    const order: string[] = [];
    let release!: () => void;
    const held = withSiteRouteLock('abc123', () => new Promise<void>((r) => { release = () => { order.push('deploy'); r(); }; }));
    vi.mocked(provisionTraefikRouteUnlocked).mockImplementation(async () => { order.push('reconcile'); return { ok: true }; });
    const pending = reconcileSite(clientFor(nixApp()), nixApp(), confDir, 'letsencrypt');
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual([]);
    release();
    await held;
    await pending;
    expect(order).toEqual(['deploy', 'reconcile']);
  });

  it('leaves operator-managed route files alone', async () => {
    mockDocker([{ Id: 'c1', Created: 1 }], {});
    writeFileSync(path.join(confDir, 'site-abc123.yml'), '# hermithost:managed=false\nhttp: {}\n');
    expect(await reconcileSite(clientFor(nixApp()), nixApp(), confDir, 'letsencrypt'))
      .toMatchObject({ status: 'skipped', reason: 'route marked hermithost:managed=false' });
  });

  it('only considers production containers, newest first', async () => {
    mockDocker([{ Id: 'old', Created: 1 }, { Id: 'new', Created: 5 }], { [NET]: { Aliases: ['site-abc123'] } });
    writeRoute('abc123', 'abc123.example.com', 'site-abc123:3000');
    await reconcileSite(clientFor(nixApp()), nixApp(), confDir, 'letsencrypt');
    const filters = JSON.parse(decodeURIComponent((vi.mocked(dockerGet).mock.calls[0][0] as string).split('filters=')[1]));
    expect(filters.label).toEqual(['coolify.name=abc123', 'coolify.pullRequestId=0']);
    expect(vi.mocked(dockerGet).mock.calls[1][0]).toBe('/containers/new/json');
  });

  it('looks up the compose primary service container by compose labels', async () => {
    mockDocker([{ Id: 'c1', Created: 1 }], { [NET]: { Aliases: ['site-cmp456'] } });
    writeRoute('cmp456', 'cmp456.example.com', 'site-cmp456:80');
    await reconcileSite(clientFor(composeApp()), composeApp(), confDir, 'letsencrypt');
    const filters = JSON.parse(decodeURIComponent((vi.mocked(dockerGet).mock.calls[0][0] as string).split('filters=')[1]));
    expect(filters.label).toEqual(['com.docker.compose.project=cmp456', 'com.docker.compose.service=app']);
  });

  it('skips stopped sites, sites without a domain, and unparsed compose apps', async () => {
    mockDocker([]);
    const c = clientFor(nixApp());
    expect(await reconcileSite(c, nixApp(), confDir, 'letsencrypt')).toMatchObject({ status: 'skipped', reason: 'no running container' });
    expect(await reconcileSite(c, nixApp('abc123', { fqdn: null }), confDir, 'letsencrypt')).toMatchObject({ status: 'skipped', reason: 'no domain' });
    expect(await reconcileSite(c, { ...composeApp(), docker_compose_raw: null } as unknown as CoolifyApplication, confDir, 'letsencrypt'))
      .toMatchObject({ status: 'skipped', reason: 'compose not parsed yet' });
    expect(provisionTraefikRouteUnlocked).not.toHaveBeenCalled();
  });

  it('reports a failed heal with the provisioning reason', async () => {
    mockDocker([{ Id: 'c1', Created: 1 }], {});
    vi.mocked(provisionTraefikRouteUnlocked).mockResolvedValue({ ok: false, reason: 'route returned 502' });
    expect(await reconcileSite(clientFor(nixApp()), nixApp(), confDir, 'letsencrypt'))
      .toMatchObject({ status: 'failed', reason: 'route returned 502' });
  });
});

describe('reconcileIntervalMs', () => {
  it('defaults to 60s, accepts 0 to disable, and rejects junk', () => {
    expect(reconcileIntervalMs(undefined)).toBe(60_000);
    expect(reconcileIntervalMs('')).toBe(60_000);
    expect(reconcileIntervalMs('30000')).toBe(30_000);
    expect(reconcileIntervalMs('0')).toBe(0);
    expect(reconcileIntervalMs('60s')).toBe(60_000);
    expect(reconcileIntervalMs('-5')).toBe(60_000);
  });
});
