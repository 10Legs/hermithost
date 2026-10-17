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
  followDeploymentAndProvisionRoute,
  isTerminalDeployStatus,
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

describe('followDeploymentAndProvisionRoute (#139)', () => {
  const ok = { ok: true, upstream: 'site-abc:8088' };
  function deps(statuses: string[], routes: Array<{ ok: boolean; reason?: string; upstream?: string }>) {
    let t = 0;
    const getDeploymentStatus = vi.fn(async () => statuses.shift() ?? 'in_progress');
    const provisionRoute = vi.fn(async () => routes.shift() ?? { ok: false, reason: 'no running container' });
    return {
      getDeploymentStatus,
      provisionRoute,
      sleep: async (ms: number) => { t += ms; },
      now: () => t,
    };
  }

  it('waits for a long build to finish, then writes the route', async () => {
    // 30 polls × 10s = 5 min of building — longer than the old 3-minute request wait.
    const d = deps([...Array(30).fill('in_progress'), 'finished'], [ok]);
    const r = await followDeploymentAndProvisionRoute('abc', 'job1', d);
    expect(r).toEqual({ outcome: 'routed', route: ok });
    expect(d.getDeploymentStatus).toHaveBeenCalledTimes(31);
    expect(d.provisionRoute).toHaveBeenCalledTimes(1);
  });

  it('retries the route briefly after finish while the container comes up', async () => {
    const d = deps(['finished'], [{ ok: false, reason: 'no running container' }, { ok: false, reason: 'no running container' }, ok]);
    expect((await followDeploymentAndProvisionRoute('abc', 'job1', d)).outcome).toBe('routed');
    expect(d.provisionRoute).toHaveBeenCalledTimes(3);
  });

  it('leaves the route alone when the deployment fails or is cancelled', async () => {
    for (const status of ['failed', 'cancelled-by-user']) {
      const d = deps(['queued', status], [ok]);
      expect(await followDeploymentAndProvisionRoute('abc', 'job1', d)).toEqual({ outcome: 'deploy-failed', status });
      expect(d.provisionRoute).not.toHaveBeenCalled();
    }
  });

  it('keeps polling through transient status read errors', async () => {
    const d = deps([], [ok]);
    d.getDeploymentStatus
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce('finished');
    expect((await followDeploymentAndProvisionRoute('abc', 'job1', d)).outcome).toBe('routed');
  });

  it('gives up after the follow timeout without touching the route', async () => {
    const d = deps([], [ok]); // never terminal
    expect(await followDeploymentAndProvisionRoute('abc', 'job1', d)).toEqual({ outcome: 'timeout' });
    expect(d.provisionRoute).not.toHaveBeenCalled();
  });

  it('reports route-failed when the container never becomes routable', async () => {
    const d = deps(['finished'], []);
    const r = await followDeploymentAndProvisionRoute('abc', 'job1', d);
    expect(r.outcome).toBe('route-failed');
    expect(d.provisionRoute).toHaveBeenCalledTimes(12);
  });

  it('without a jobId, polls for the new container until it is routable', async () => {
    const d = deps([], [{ ok: false }, { ok: false }, ok]);
    expect((await followDeploymentAndProvisionRoute('abc', undefined, d)).outcome).toBe('routed');
    expect(d.getDeploymentStatus).not.toHaveBeenCalled();
  });

  it('classifies terminal Coolify statuses', () => {
    expect(['finished', 'failed', 'cancelled-by-user', 'cancelled'].every(isTerminalDeployStatus)).toBe(true);
    expect(['queued', 'in_progress', ''].some(isTerminalDeployStatus)).toBe(false);
  });
});
