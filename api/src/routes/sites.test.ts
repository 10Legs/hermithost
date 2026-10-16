import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import * as path from 'path';

// sites.ts reads TRAEFIK_CONF_DIR at import time, so set it before imports run.
const confDir = vi.hoisted(() => {
  const { mkdtempSync } = require('fs') as typeof import('fs');
  const { tmpdir } = require('os') as typeof import('os');
  const { join } = require('path') as typeof import('path');
  const dir = mkdtempSync(join(tmpdir(), 'sites-route-'));
  process.env.TRAEFIK_CONF_DIR = dir;
  return dir;
});

vi.mock('../services/docker', () => ({
  dockerGet: vi.fn(),
  dockerPost: vi.fn(),
  dockerNetworkConnect: vi.fn(),
  dockerNetworkDisconnect: vi.fn(),
}));
vi.mock('../services/healthProbe', () => ({
  clearProbeCache: vi.fn(),
  probeSite: vi.fn(),
}));

import { dockerGet, dockerNetworkConnect, dockerNetworkDisconnect } from '../services/docker';
import { probeSite } from '../services/healthProbe';
import {
  buildTraefikRouteYaml,
  pickPrimaryComposeService,
  provisionTraefikRoute,
  stableComposeRouteAlias,
  stableSiteRouteAlias,
} from './sites';

describe('stableComposeRouteAlias', () => {
  it('uses a stable site-scoped alias instead of an ephemeral Coolify container name', () => {
    expect(stableComposeRouteAlias('c1ngfacciakfgbxmt96uaeoz')).toBe('site-c1ngfacciakfgbxmt96uaeoz');
    expect(stableSiteRouteAlias('lv44itdkau12rdgxomfi28j9')).toBe('site-lv44itdkau12rdgxomfi28j9');
  });
});

describe('buildTraefikRouteYaml', () => {
  it('routes to the given upstream with a per-host resolver in public mode', () => {
    const yml = buildTraefikRouteYaml('abc', 'a.example.com', 'site-abc:3000', 'letsencrypt');
    expect(yml).toContain('rule: "Host(`a.example.com`)"');
    expect(yml).toContain('certResolver: letsencrypt');
    expect(yml).toContain('- url: "http://site-abc:3000"');
  });

  it('emits bare tls for internal-ca (wildcard cert owns issuance)', () => {
    const yml = buildTraefikRouteYaml('abc', 'a.hh', 'site-abc:80', 'internal-ca');
    expect(yml).toContain('      tls: {}');
    expect(yml).not.toContain('certResolver');
  });
});

describe('pickPrimaryComposeService', () => {
  it('prefers known web service names, else the first service', () => {
    expect(pickPrimaryComposeService('services:\n  db: {}\n  app: {}\n').primary).toBe('app');
    expect(pickPrimaryComposeService('services:\n  worker: {}\n  db: {}\n').primary).toBe('worker');
    expect(pickPrimaryComposeService('services: {}\n').primary).toBeUndefined();
  });
});

describe('provisionTraefikRoute (nixpacks) — #127', () => {
  const NET = 'hermithost-coolify';

  beforeEach(() => {
    vi.resetAllMocks();
    process.env.COOLIFY_NETWORK_NAME = NET;
    vi.mocked(probeSite).mockResolvedValue({ http: { reachable: true, statusCode: 200 } } as never);
  });

  function mockContainer(networks: Record<string, { Aliases: string[] | null }>) {
    vi.mocked(dockerGet).mockImplementation(async (p: string) => {
      if (p.startsWith('/containers/json')) {
        return [
          { Id: 'old', Names: ['/lv44-100'], Created: 100 },
          { Id: 'new', Names: ['/lv44-200'], Created: 200 },
        ];
      }
      if (p === '/containers/new/json') return { NetworkSettings: { Networks: networks } };
      throw new Error(`unexpected ${p}`);
    });
  }

  it('attaches a container stranded on the bare coolify network and routes via the stable alias', async () => {
    mockContainer({ coolify: { Aliases: ['lv44-200'] } });
    const out = await provisionTraefikRoute('lv44', 'pf.example.com', 3000, 'letsencrypt');

    expect(out).toMatchObject({ ok: true, upstream: 'site-lv44:3000', statusCode: 200 });
    expect(dockerNetworkDisconnect).not.toHaveBeenCalled();
    expect(dockerNetworkConnect).toHaveBeenCalledWith(NET, 'new', ['site-lv44']);
    const yml = readFileSync(path.join(confDir, 'site-lv44.yml'), 'utf8');
    expect(yml).toContain('- url: "http://site-lv44:3000"');
    expect(yml).not.toContain('lv44-200');
  });

  it('re-adds the alias when the container is already on the network without it', async () => {
    mockContainer({ [NET]: { Aliases: [] } });
    await provisionTraefikRoute('lv44', 'pf.example.com', 3000, 'letsencrypt');
    expect(dockerNetworkDisconnect).toHaveBeenCalledWith(NET, 'new');
    expect(dockerNetworkConnect).toHaveBeenCalledWith(NET, 'new', ['site-lv44']);
  });

  it('does not touch networking when the alias is already present', async () => {
    mockContainer({ [NET]: { Aliases: ['site-lv44'] } });
    await provisionTraefikRoute('lv44', 'pf.example.com', 3000, 'letsencrypt');
    expect(dockerNetworkDisconnect).not.toHaveBeenCalled();
    expect(dockerNetworkConnect).not.toHaveBeenCalled();
  });

  it('during a deploy, ignores the container being replaced (minCreated)', async () => {
    mockContainer({ [NET]: { Aliases: ['site-lv44'] } });
    vi.mocked(dockerGet).mockImplementation(async (p: string) => {
      if (p.startsWith('/containers/json')) return [{ Id: 'old', Names: ['/lv44-100'], Created: 100 }];
      throw new Error(`unexpected ${p}`);
    });
    const out = await provisionTraefikRoute('lv44', 'pf.example.com', 3000, 'letsencrypt', { minCreated: 150 });
    expect(out).toMatchObject({ ok: false, reason: 'no running container for slug lv44' });
    expect(dockerNetworkConnect).not.toHaveBeenCalled();
  });

  it('filters to production containers (excludes Coolify previews)', async () => {
    mockContainer({ [NET]: { Aliases: ['site-lv44'] } });
    await provisionTraefikRoute('lv44', 'pf.example.com', 3000, 'letsencrypt');
    const listCall = vi.mocked(dockerGet).mock.calls.find(([p]) => (p as string).startsWith('/containers/json'))![0] as string;
    expect(JSON.parse(decodeURIComponent(listCall.split('filters=')[1])).label)
      .toEqual(['coolify.name=lv44', 'coolify.pullRequestId=0']);
  });

  it('routes to the first port when ports_exposes lists several', async () => {
    mockContainer({ [NET]: { Aliases: ['site-lv44'] } });
    const out = await provisionTraefikRoute('lv44', 'pf.example.com', '3000,8080', 'letsencrypt');
    expect(out.upstream).toBe('site-lv44:3000');
  });

  it('treats an unreachable probe (DNS/cert not ready) as a warning, not a failure', async () => {
    mockContainer({ [NET]: { Aliases: ['site-lv44'] } });
    vi.mocked(probeSite).mockResolvedValue({ http: { reachable: false, statusCode: null } } as never);
    const out = await provisionTraefikRoute('lv44', 'pf.example.com', 3000, 'letsencrypt');
    expect(out).toMatchObject({ ok: true, upstream: 'site-lv44:3000' });
  });

  it('fails when the route still returns 502 after provisioning', async () => {
    mockContainer({ [NET]: { Aliases: ['site-lv44'] } });
    vi.mocked(probeSite).mockResolvedValue({ http: { reachable: true, statusCode: 502 } } as never);
    const out = await provisionTraefikRoute('lv44', 'pf.example.com', 3000, 'letsencrypt');
    expect(out.ok).toBe(false);
    expect(out.reason).toContain('502');
  });

  it('writes nothing when no container is running', async () => {
    vi.mocked(dockerGet).mockResolvedValue([]);
    const out = await provisionTraefikRoute('gone', 'g.example.com', 3000, 'letsencrypt');
    expect(out).toMatchObject({ ok: false, reason: 'no running container for slug gone' });
  });
});
