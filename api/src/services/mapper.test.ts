import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mapSite, formatSiteUrl, resolveRouteDomain } from './mapper';
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

// ── formatSiteUrl (Phase B) ───────────────────────────────────────────────────

describe('formatSiteUrl — Phase B URL rendering', () => {
  const origHttps = process.env.PUBLIC_BASE_PORT_HTTPS;
  const origHttp  = process.env.PUBLIC_BASE_PORT_HTTP;

  afterEach(() => {
    // Restore env after each case
    if (origHttps === undefined) delete process.env.PUBLIC_BASE_PORT_HTTPS;
    else process.env.PUBLIC_BASE_PORT_HTTPS = origHttps;
    if (origHttp === undefined) delete process.env.PUBLIC_BASE_PORT_HTTP;
    else process.env.PUBLIC_BASE_PORT_HTTP = origHttp;
  });

  it('omits port when PUBLIC_BASE_PORT_HTTPS=443 (LAN mode)', () => {
    process.env.PUBLIC_BASE_PORT_HTTPS = '443';
    expect(formatSiteUrl('example.hh', 'https')).toBe('https://example.hh');
  });

  it('appends port when PUBLIC_BASE_PORT_HTTPS=8443 (internet mode)', () => {
    process.env.PUBLIC_BASE_PORT_HTTPS = '8443';
    expect(formatSiteUrl('example.hh', 'https')).toBe('https://example.hh:8443');
  });

  it('omits port when PUBLIC_BASE_PORT_HTTP=80 (LAN mode)', () => {
    process.env.PUBLIC_BASE_PORT_HTTP = '80';
    expect(formatSiteUrl('example.hh', 'http')).toBe('http://example.hh');
  });

  it('appends port when PUBLIC_BASE_PORT_HTTP=8080 (internet mode)', () => {
    process.env.PUBLIC_BASE_PORT_HTTP = '8080';
    expect(formatSiteUrl('example.hh', 'http')).toBe('http://example.hh:8080');
  });

  it('defaults to https://example.hh:8443 when PUBLIC_BASE_PORT_HTTPS is unset', () => {
    delete process.env.PUBLIC_BASE_PORT_HTTPS;
    expect(formatSiteUrl('example.hh', 'https')).toBe('https://example.hh:8443');
  });

  it('defaults to http://example.hh:8080 when PUBLIC_BASE_PORT_HTTP is unset', () => {
    delete process.env.PUBLIC_BASE_PORT_HTTP;
    expect(formatSiteUrl('example.hh', 'http')).toBe('http://example.hh:8080');
  });

  it('falls back to default and emits a warning on non-numeric PUBLIC_BASE_PORT_HTTPS', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.PUBLIC_BASE_PORT_HTTPS = 'not-a-port';
    const result = formatSiteUrl('example.hh', 'https');
    // Falls back to 8443 (default) — non-default so port is appended
    expect(result).toBe('https://example.hh:8443');
    warnSpy.mockRestore();
  });
});

// ── resolveRouteDomain (Phase C) ──────────────────────────────────────────────

describe('resolveRouteDomain — Phase C .hh routing fix', () => {
  it('returns the compose domain for a dockercompose app with docker_compose_domains', () => {
    const app = makeApp({
      build_pack: 'dockercompose',
      fqdn: 'https://placeholder.12.34.56.78.sslip.io',
      docker_compose_domains: '{"web":{"domain":"https://example.hh"}}',
    });
    expect(resolveRouteDomain(app)).toBe('example.hh');
  });

  it('returns the fqdn host for a non-dockercompose app', () => {
    const app = makeApp({
      build_pack: 'nixpacks',
      fqdn: 'https://mysite.example.com',
      docker_compose_domains: null,
    });
    expect(resolveRouteDomain(app)).toBe('mysite.example.com');
  });

  it('returns null when both fqdn and docker_compose_domains are unset', () => {
    const app = makeApp({
      fqdn: null,
      docker_compose_domains: null,
    });
    expect(resolveRouteDomain(app)).toBeNull();
  });

  it('strips protocol and path from fqdn: https://example.hh/path → example.hh', () => {
    const app = makeApp({
      build_pack: 'nixpacks',
      fqdn: 'https://example.hh/some/path',
      docker_compose_domains: null,
    });
    expect(resolveRouteDomain(app)).toBe('example.hh');
  });

  it('returns the first domain from a comma-separated fqdn', () => {
    const app = makeApp({
      build_pack: 'nixpacks',
      fqdn: 'https://primary.example.com,https://alias.example.com',
      docker_compose_domains: null,
    });
    expect(resolveRouteDomain(app)).toBe('primary.example.com');
  });

  it('strips trailing path segments: https://example.hh/foo/bar → example.hh', () => {
    const app = makeApp({
      build_pack: 'nixpacks',
      fqdn: 'https://example.hh/foo/bar',
      docker_compose_domains: null,
    });
    expect(resolveRouteDomain(app)).toBe('example.hh');
  });

  it('DELETE-style: dockercompose app with compose domain returns .hh, not sslip fqdn', () => {
    // Simulates the DELETE /api/sites/:slug teardown scenario where fqdn is
    // frozen to the sslip.io placeholder but docker_compose_domains holds the
    // real .hh zone that must be torn down.
    const app = makeApp({
      build_pack: 'dockercompose',
      fqdn: 'https://v13-abc123.12.34.56.78.sslip.io',
      docker_compose_domains: '{"web":{"domain":"example.hh"}}',
    });
    expect(resolveRouteDomain(app)).toBe('example.hh');
  });
});
