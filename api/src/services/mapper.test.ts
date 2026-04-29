import { describe, it, expect } from 'vitest';
import { mapSite } from './mapper';
import type { CoolifyApplication } from './coolify';

// Minimal CoolifyApplication fixture for mapper tests
function makeApp(overrides: Partial<CoolifyApplication> = {}): CoolifyApplication {
  return {
    uuid: 'test-uuid',
    name: 'test-site',
    description: null,
    fqdn: 'http://placeholder.sslip.io',
    status: 'running',
    git_repository: 'https://github.com/org/repo.git',
    git_branch: 'main',
    git_commit_sha: 'abc123',
    build_pack: 'dockercompose',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('resolveDisplayDomain — docker_compose_domains JSON string parsing (Bug 1)', () => {
  it('parses docker_compose_domains when Coolify returns it as a JSON string', () => {
    const app = makeApp({
      docker_compose_domains: '{"frontend":{"domain":"https://qa-pr77v3.localdev.test"}}',
    });
    const site = mapSite(app, [], null);
    // Should use the parsed domain, not the sslip.io fqdn placeholder
    expect(site.domain).toBe('qa-pr77v3.localdev.test');
  });

  it('uses fqdn fallback when docker_compose_domains is a malformed JSON string', () => {
    const app = makeApp({
      fqdn: 'http://fallback.sslip.io',
      docker_compose_domains: '{not-valid-json',
    });
    const site = mapSite(app, [], null);
    expect(site.domain).toBe('fallback.sslip.io');
  });

  it('parses docker_compose_domains when it is already an object (no double-parse)', () => {
    const app = makeApp({
      docker_compose_domains: { frontend: { domain: 'https://object-form.localdev.test' } },
    });
    const site = mapSite(app, [], null);
    expect(site.domain).toBe('object-form.localdev.test');
  });

  it('strips https:// scheme from the resolved domain', () => {
    const app = makeApp({
      docker_compose_domains: '{"web":{"domain":"https://my-site.example.com"}}',
    });
    const site = mapSite(app, [], null);
    expect(site.domain).toBe('my-site.example.com');
  });

  it('uses fqdn fallback for non-dockercompose apps', () => {
    const app = makeApp({
      build_pack: 'nixpacks',
      fqdn: 'https://nixpacks-site.example.com',
      docker_compose_domains: null,
    });
    const site = mapSite(app, [], null);
    expect(site.domain).toBe('nixpacks-site.example.com');
  });

  it('falls through to fqdn when docker_compose_domains string has no domain field', () => {
    const app = makeApp({
      fqdn: 'http://fallback.sslip.io',
      // Valid JSON but no .domain inside
      docker_compose_domains: '{"frontend":{}}',
    });
    const site = mapSite(app, [], null);
    expect(site.domain).toBe('fallback.sslip.io');
  });
});
