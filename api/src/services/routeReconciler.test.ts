import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';

vi.mock('./docker', () => ({ dockerGet: vi.fn() }));
vi.mock('../routes/sites', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../routes/sites')>();
  return {
    ...actual,
    provisionTraefikRoute: vi.fn(),
    provisionTraefikRouteForCompose: vi.fn(),
  };
});

import { dockerGet } from './docker';
import { provisionTraefikRoute, provisionTraefikRouteForCompose } from '../routes/sites';
import { reconcileSite } from './routeReconciler';
import type { CoolifyApplication, CoolifyClient } from './coolify';

const NET = 'hermithost-coolify';
const client = {} as CoolifyClient;

function nixApp(uuid = 'abc123'): CoolifyApplication {
  return { uuid, build_pack: 'nixpacks', fqdn: `https://${uuid}.example.com`, ports_exposes: '3000' } as unknown as CoolifyApplication;
}
function composeApp(uuid = 'cmp456'): CoolifyApplication {
  return {
    uuid,
    build_pack: 'dockercompose',
    fqdn: `https://${uuid}.example.com`,
    docker_compose_raw: 'services:\n  db: {image: postgres}\n  app: {image: nginx}\n',
  } as unknown as CoolifyApplication;
}

// dockerGet mock: container list, then inspect with the given networks.
function mockDocker(containers: Array<{ Id: string; Created: number }>, networks: Record<string, { Aliases: string[] | null }> = {}) {
  vi.mocked(dockerGet).mockImplementation(async (p: string) => {
    if (p.startsWith('/containers/json')) return containers;
    if (p.endsWith('/json')) return { NetworkSettings: { Networks: networks } };
    throw new Error(`unexpected ${p}`);
  });
}

let confDir: string;
function writeRoute(slug: string, upstream: string) {
  writeFileSync(path.join(confDir, `site-${slug}.yml`), `    servers:\n          - url: "http://${upstream}"\n`);
}

beforeEach(() => {
  vi.resetAllMocks();
  process.env.COOLIFY_NETWORK_NAME = NET;
  confDir = mkdtempSync(path.join(tmpdir(), 'reconcile-'));
  vi.mocked(provisionTraefikRoute).mockResolvedValue({ ok: true });
  vi.mocked(provisionTraefikRouteForCompose).mockResolvedValue({ ok: true });
});

describe('reconcileSite', () => {
  it('leaves a healthy site alone (alias on network + route targets alias)', async () => {
    mockDocker([{ Id: 'c1', Created: 1 }], { [NET]: { Aliases: ['site-abc123'] } });
    writeRoute('abc123', 'site-abc123:3000');
    const out = await reconcileSite(client, nixApp(), confDir, 'letsencrypt');
    expect(out).toEqual({ slug: 'abc123', status: 'healthy' });
    expect(provisionTraefikRoute).not.toHaveBeenCalled();
  });

  it('heals a nixpacks container stranded on the bare coolify network (#127)', async () => {
    mockDocker([{ Id: 'c1', Created: 1 }], { coolify: { Aliases: ['abc123-1'] } });
    writeRoute('abc123', 'abc123-151051441837:3000');
    const out = await reconcileSite(client, nixApp(), confDir, 'letsencrypt');
    expect(out).toMatchObject({ status: 'healed', issues: [`container not on ${NET}`, 'route does not target stable alias'] });
    expect(provisionTraefikRoute).toHaveBeenCalledWith('abc123', 'abc123.example.com', '3000', 'letsencrypt');
  });

  it('heals a container that is on the network but lost its alias after a recreate (#126)', async () => {
    mockDocker([{ Id: 'c2', Created: 2 }], { [NET]: { Aliases: null } });
    writeRoute('cmp456', 'site-cmp456:80');
    const app = composeApp();
    const out = await reconcileSite(client, app, confDir, 'internal-ca');
    expect(out).toMatchObject({ status: 'healed', issues: [`missing alias site-cmp456 on ${NET}`] });
    expect(provisionTraefikRouteForCompose).toHaveBeenCalledWith(client, app, 'cmp456.example.com', 'internal-ca');
  });

  it('recreates a missing route file', async () => {
    mockDocker([{ Id: 'c1', Created: 1 }], { [NET]: { Aliases: ['site-abc123'] } });
    const out = await reconcileSite(client, nixApp(), confDir, 'letsencrypt');
    expect(out).toMatchObject({ status: 'healed', issues: ['route file missing'] });
  });

  it('looks up the compose primary service container by compose labels', async () => {
    mockDocker([{ Id: 'c1', Created: 1 }], { [NET]: { Aliases: ['site-cmp456'] } });
    writeRoute('cmp456', 'site-cmp456:80');
    await reconcileSite(client, composeApp(), confDir, 'letsencrypt');
    const listCall = vi.mocked(dockerGet).mock.calls[0][0] as string;
    const filters = JSON.parse(decodeURIComponent(listCall.split('filters=')[1]));
    expect(filters.label).toEqual(['com.docker.compose.project=cmp456', 'com.docker.compose.service=app']);
    expect(filters.status).toEqual(['running']);
  });

  it('inspects the newest running container', async () => {
    mockDocker([{ Id: 'old', Created: 1 }, { Id: 'new', Created: 5 }], { [NET]: { Aliases: ['site-abc123'] } });
    writeRoute('abc123', 'site-abc123:3000');
    await reconcileSite(client, nixApp(), confDir, 'letsencrypt');
    expect(vi.mocked(dockerGet).mock.calls[1][0]).toBe('/containers/new/json');
  });

  it('skips stopped sites, sites without a domain, and unparsed compose apps', async () => {
    mockDocker([]);
    expect(await reconcileSite(client, nixApp(), confDir, 'letsencrypt')).toMatchObject({ status: 'skipped', reason: 'no running container' });
    expect(await reconcileSite(client, { ...nixApp(), fqdn: null } as unknown as CoolifyApplication, confDir, 'letsencrypt'))
      .toMatchObject({ status: 'skipped', reason: 'no domain' });
    expect(await reconcileSite(client, { ...composeApp(), docker_compose_raw: null } as unknown as CoolifyApplication, confDir, 'letsencrypt'))
      .toMatchObject({ status: 'skipped', reason: 'compose not parsed yet' });
    expect(provisionTraefikRoute).not.toHaveBeenCalled();
  });

  it('reports a failed heal with the provisioning reason', async () => {
    mockDocker([{ Id: 'c1', Created: 1 }], {});
    vi.mocked(provisionTraefikRoute).mockResolvedValue({ ok: false, reason: 'route returned 502' });
    const out = await reconcileSite(client, nixApp(), confDir, 'letsencrypt');
    expect(out).toMatchObject({ status: 'failed', reason: 'route returned 502' });
  });
});
