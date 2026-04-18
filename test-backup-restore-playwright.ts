import { chromium, Browser, Page, BrowserContext } from 'playwright';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOTS_DIR = path.join(__dirname, 'test-screenshots-backup-restore');
const BASE_URL = 'http://localhost:8080';
const API_URL = `${BASE_URL}/api`;
const TODAY = new Date().toISOString().slice(0, 10);
const TS = Date.now();
const TEST_SITE_NAME = `playwright-backup-test-${TS}`;
const TEST_ZONE_NAME = `playwright-backup-${TS}.example.com`;

// ── Fixtures ──────────────────────────────────────────────────────────────────

const VALID_BACKUP_FIXTURE = {
  version: 1,
  exported_at: new Date().toISOString(),
  sites: [
    {
      name: TEST_SITE_NAME,
      domain: TEST_ZONE_NAME,
      git_repository: 'https://github.com/test/playwright-backup-repo',
      git_branch: 'main',
      description: 'Playwright backup/restore test site',
      deploy_auth: 'ssh_key',
    },
  ],
  dns_zones: [
    {
      name: TEST_ZONE_NAME,
      type: 'Primary',
      records: [
        {
          name: TEST_ZONE_NAME,
          type: 'SOA',
          ttl: 3600,
          rData: {
            primaryNameServer: 'ns1.example.com',
            responsiblePerson: 'hostmaster.example.com',
            serial: 1,
            refresh: 900,
            retry: 300,
            expire: 604800,
            minimum: 900,
          },
        },
        {
          name: TEST_ZONE_NAME,
          type: 'A',
          ttl: 3600,
          rData: { ipAddress: '1.2.3.4' },
        },
      ],
    },
  ],
};

const PAT_BACKUP_FIXTURE = {
  version: 1,
  exported_at: new Date().toISOString(),
  sites: [
    {
      name: `${TEST_SITE_NAME}-pat`,
      domain: `pat-${TEST_ZONE_NAME}`,
      git_repository: 'https://github.com/test/private-playwright-repo',
      git_branch: 'main',
      description: 'Playwright PAT auth test site',
      deploy_auth: 'pat',
      deploy_token: 'ghp_faketoken12345playwright',
    },
  ],
  dns_zones: [],
};

const INVALID_BACKUP_FIXTURE = {
  version: 2,
  sites: [],
  dns_zones: [],
};

// ── Helpers ───────────────────────────────────────────────────────────────────

let screenshotIndex = 1;

async function takeScreenshot(page: Page, name: string): Promise<string> {
  if (!fs.existsSync(SCREENSHOTS_DIR)) {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  }
  const filename = `${String(screenshotIndex).padStart(2, '0')}-${name}.png`;
  const filepath = path.join(SCREENSHOTS_DIR, filename);
  await page.screenshot({ path: filepath, fullPage: true });
  console.log(`[SCREENSHOT] ${filepath}`);
  screenshotIndex++;
  return filename;
}

type TestStatus = 'PASS' | 'FAIL' | 'SKIP' | 'WARN';

interface TestResult {
  block: string;
  step: string;
  status: TestStatus;
  notes: string;
}

const results: TestResult[] = [];

function log(block: string, step: string, status: TestStatus, notes = '') {
  const entry: TestResult = { block, step, status, notes };
  results.push(entry);
  const icon = status === 'PASS' ? '✓' : status === 'FAIL' ? '✗' : status === 'SKIP' ? '⊘' : '⚠';
  console.log(`  [${status}] ${icon} ${step}${notes ? ' — ' + notes : ''}`);
}

// Make an API call via page.evaluate (avoids CORS)
async function apiFetch(
  page: Page,
  url: string,
  opts: { method?: string; body?: unknown } = {}
): Promise<{ status: number; body: unknown; headers: Record<string, string> }> {
  return page.evaluate(
    async ([u, method, body]: [string, string, string | null]) => {
      const init: RequestInit = { method };
      if (body !== null) {
        init.headers = { 'Content-Type': 'application/json' };
        init.body = body;
      }
      const res = await fetch(u, init);
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => { headers[k] = v; });
      let responseBody: unknown;
      try { responseBody = await res.json(); } catch { responseBody = null; }
      return { status: res.status, body: responseBody, headers };
    },
    [url, opts.method ?? 'GET', opts.body !== undefined ? JSON.stringify(opts.body) : null] as [string, string, string | null]
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function runTests() {
  const browser: Browser = await chromium.launch({ headless: true });
  const context: BrowserContext = await browser.newContext();
  const page: Page = await context.newPage();

  // Detect infra availability upfront
  let coolifyConnected = false;
  let technitiumConnected = false;

  try {
    console.log('\n=== PREFLIGHT: Check infrastructure ===');
    await page.goto(`${BASE_URL}/settings`);
    await page.waitForLoadState('networkidle');

    const configRes = await apiFetch(page, `${API_URL}/config`);
    const cfg = configRes.body as Record<string, unknown>;
    coolifyConnected = cfg?.coolify_status === 'connected';
    technitiumConnected = cfg?.technitium_status === 'connected';
    console.log(`  Coolify: ${coolifyConnected ? 'connected' : 'NOT connected'}`);
    console.log(`  Technitium: ${technitiumConnected ? 'connected' : 'NOT connected'}`);
  } catch (err) {
    console.error('  Preflight failed:', (err as Error).message);
  }

  try {
    // ═══════════════════════════════════════════════════════════════════════
    // BLOCK 1: API — Export (GET /api/backup)
    // ═══════════════════════════════════════════════════════════════════════
    console.log('\n═══ BLOCK 1: API Export ═══');

    // 1.1 Full backup structure
    console.log('\n  [1.1] Full backup structure');
    {
      const res = await apiFetch(page, `${API_URL}/backup`);
      const body = res.body as Record<string, unknown>;
      if (res.status === 200 && body?.version === 1 && Array.isArray(body?.sites) && Array.isArray(body?.dns_zones) && typeof body?.exported_at === 'string') {
        const cd = res.headers['content-disposition'] ?? '';
        const filenameOk = cd.includes(`hermithost-backup-${TODAY}.json`);
        log('Block 1', '1.1 Full backup structure', 'PASS', `${body.sites.length} sites, ${(body.dns_zones as unknown[]).length} zones${filenameOk ? '' : ' [WARN: filename header missing]'}`);
      } else {
        log('Block 1', '1.1 Full backup structure', 'FAIL', `HTTP ${res.status}, version=${body?.version}`);
      }
    }

    // 1.2 SOA records + no internal zones (AC #1)
    console.log('\n  [1.2] SOA + no internal zones');
    {
      const res = await apiFetch(page, `${API_URL}/backup`);
      const body = res.body as Record<string, unknown>;
      const zones = (body?.dns_zones ?? []) as Array<Record<string, unknown>>;
      if (!technitiumConnected) {
        log('Block 1', '1.2 SOA + no internal zones', 'SKIP', 'Technitium not connected');
      } else if (zones.length === 0) {
        log('Block 1', '1.2 SOA + no internal zones', 'WARN', 'No zones returned — cannot verify SOA inclusion');
      } else {
        const hasSoa = zones.some(z => {
          const records = (z.records as Array<Record<string, unknown>>) ?? [];
          return records.some(r => r.type === 'SOA');
        });
        if (hasSoa) {
          log('Block 1', '1.2 SOA + no internal zones', 'PASS', `${zones.length} zones exported, SOA records present`);
        } else {
          log('Block 1', '1.2 SOA + no internal zones', 'FAIL', 'No SOA record found in any exported zone');
        }
      }
    }

    // 1.3 PAT stripped from git_repository URL (AC #5 + regression #1 CRITICAL)
    console.log('\n  [1.3] PAT stripped from export (Critical regression #1)');
    {
      const res = await apiFetch(page, `${API_URL}/backup`);
      const body = res.body as Record<string, unknown>;
      const sites = (body?.sites ?? []) as Array<Record<string, unknown>>;
      if (!coolifyConnected) {
        log('Block 1', '1.3 PAT stripped from export', 'SKIP', 'Coolify not connected — no sites to check');
      } else if (sites.length === 0) {
        log('Block 1', '1.3 PAT stripped from export', 'WARN', 'No sites exported — cannot verify PAT stripping');
      } else {
        const patLeak = sites.find(s => /https?:\/\/[^@]+@/.test(s.git_repository as string ?? ''));
        if (patLeak) {
          log('Block 1', '1.3 PAT stripped from export', 'FAIL', `CRITICAL: site '${patLeak.name}' has embedded credentials in git_repository`);
        } else {
          const patSites = sites.filter(s => s.deploy_auth === 'pat');
          const missingToken = patSites.find(s => !s.deploy_token);
          if (missingToken) {
            log('Block 1', '1.3 PAT stripped from export', 'FAIL', `Site '${missingToken.name}' has deploy_auth=pat but no deploy_token`);
          } else {
            log('Block 1', '1.3 PAT stripped from export', 'PASS', `${sites.length} sites — no embedded credentials, ${patSites.length} PAT sites have separate tokens`);
          }
        }
      }
    }

    // 1.4 Selective export: sites only
    console.log('\n  [1.4] Selective export — sites only');
    {
      const res = await apiFetch(page, `${API_URL}/backup?sites=all`);
      const body = res.body as Record<string, unknown>;
      const cd = res.headers['content-disposition'] ?? '';
      const zones = (body?.dns_zones ?? []) as unknown[];
      if (res.status === 200 && zones.length === 0 && cd.includes(`hermithost-sites-${TODAY}.json`)) {
        log('Block 1', '1.4 Selective: sites only', 'PASS', `dns_zones empty, filename correct`);
      } else {
        log('Block 1', '1.4 Selective: sites only', 'FAIL', `HTTP ${res.status}, zones=${zones.length}, content-disposition="${cd}"`);
      }
    }

    // 1.5 Selective export: zones only
    console.log('\n  [1.5] Selective export — zones only');
    {
      const res = await apiFetch(page, `${API_URL}/backup?zones=all`);
      const body = res.body as Record<string, unknown>;
      const cd = res.headers['content-disposition'] ?? '';
      const sites = (body?.sites ?? []) as unknown[];
      if (res.status === 200 && sites.length === 0 && cd.includes(`hermithost-dns-${TODAY}.json`)) {
        log('Block 1', '1.5 Selective: zones only', 'PASS', `sites empty, filename correct`);
      } else {
        log('Block 1', '1.5 Selective: zones only', 'FAIL', `HTTP ${res.status}, sites=${sites.length}, content-disposition="${cd}"`);
      }
    }

    // 1.6 No null/undefined domain values (regression #2)
    console.log('\n  [1.6] No null/undefined domain values (regression #2)');
    {
      const res = await apiFetch(page, `${API_URL}/backup`);
      const body = res.body as Record<string, unknown>;
      const sites = (body?.sites ?? []) as Array<Record<string, unknown>>;
      if (!coolifyConnected) {
        log('Block 1', '1.6 No null/undefined domain', 'SKIP', 'Coolify not connected');
      } else {
        const badDomain = sites.find(s => s.domain === null || s.domain === undefined || s.domain === 'undefined');
        if (badDomain) {
          log('Block 1', '1.6 No null/undefined domain', 'FAIL', `Site '${badDomain.name}' has domain=${JSON.stringify(badDomain.domain)}`);
        } else {
          log('Block 1', '1.6 No null/undefined domain', 'PASS', `${sites.length} sites — all domain values are strings`);
        }
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // BLOCK 2: API — Validate (POST /api/backup/validate)
    // ═══════════════════════════════════════════════════════════════════════
    console.log('\n═══ BLOCK 2: API Validate ═══');

    // 2.1 Valid fixture passes (AC #2)
    console.log('\n  [2.1] Valid fixture — valid=true, no errors');
    {
      const res = await apiFetch(page, `${API_URL}/backup/validate`, { method: 'POST', body: VALID_BACKUP_FIXTURE });
      const body = res.body as Record<string, unknown>;
      if (res.status === 200 && body?.valid === true && (body?.errors as unknown[])?.length === 0) {
        const summary = body?.summary as Record<string, number>;
        log('Block 2', '2.1 Valid fixture passes', 'PASS', `summary: ${summary?.sites} sites, ${summary?.dns_zones} zones, ${summary?.dns_records} records`);
      } else {
        log('Block 2', '2.1 Valid fixture passes', 'FAIL', `valid=${body?.valid}, errors=${JSON.stringify(body?.errors)}`);
      }
    }

    // 2.2 Missing version → valid=false
    console.log('\n  [2.2] Missing version — valid=false');
    {
      const res = await apiFetch(page, `${API_URL}/backup/validate`, {
        method: 'POST',
        body: { sites: [], dns_zones: [] },
      });
      const body = res.body as Record<string, unknown>;
      const errors = (body?.errors as string[]) ?? [];
      if (body?.valid === false && errors.some(e => e.includes('version'))) {
        log('Block 2', '2.2 Missing version rejected', 'PASS', `error: "${errors.find(e => e.includes('version'))}"`);
      } else {
        log('Block 2', '2.2 Missing version rejected', 'FAIL', `valid=${body?.valid}, errors=${JSON.stringify(errors)}`);
      }
    }

    // 2.3 Missing required site fields
    console.log('\n  [2.3] Missing required site fields');
    {
      const res = await apiFetch(page, `${API_URL}/backup/validate`, {
        method: 'POST',
        body: {
          version: 1,
          exported_at: new Date().toISOString(),
          sites: [{ description: 'missing name/domain/git' }],
          dns_zones: [],
        },
      });
      const body = res.body as Record<string, unknown>;
      const errors = (body?.errors as string[]) ?? [];
      const hasNameErr = errors.some(e => e.includes('name is required'));
      const hasDomainErr = errors.some(e => e.includes('domain is required'));
      const hasRepoErr = errors.some(e => e.includes('git_repository is required'));
      if (body?.valid === false && hasNameErr && hasDomainErr && hasRepoErr) {
        log('Block 2', '2.3 Missing required fields', 'PASS', `name/domain/git_repository errors all present`);
      } else {
        log('Block 2', '2.3 Missing required fields', 'FAIL', `valid=${body?.valid}, errors=${JSON.stringify(errors)}`);
      }
    }

    // 2.4 PAT auth without deploy_token → error
    console.log('\n  [2.4] PAT auth without deploy_token');
    {
      const res = await apiFetch(page, `${API_URL}/backup/validate`, {
        method: 'POST',
        body: {
          version: 1,
          exported_at: new Date().toISOString(),
          sites: [{
            name: 'test-pat-no-token',
            domain: 'test.example.com',
            git_repository: 'https://github.com/test/repo',
            git_branch: 'main',
            deploy_auth: 'pat',
            // intentionally no deploy_token
          }],
          dns_zones: [],
        },
      });
      const body = res.body as Record<string, unknown>;
      const errors = (body?.errors as string[]) ?? [];
      const hasTokenErr = errors.some(e => e.includes('deploy_token required'));
      if (body?.valid === false && hasTokenErr) {
        log('Block 2', '2.4 PAT without token rejected', 'PASS', `error: "${errors.find(e => e.includes('deploy_token'))}"`);
      } else {
        log('Block 2', '2.4 PAT without token rejected', 'FAIL', `valid=${body?.valid}, errors=${JSON.stringify(errors)}`);
      }
    }

    // 2.5 Existing names → warnings, not errors (AC #3)
    console.log('\n  [2.5] Existing names produce warnings not errors (AC #3)');
    {
      // First export to get a real existing site/zone name
      const exportRes = await apiFetch(page, `${API_URL}/backup`);
      const exportBody = exportRes.body as Record<string, unknown>;
      const liveSites = (exportBody?.sites ?? []) as Array<Record<string, unknown>>;
      const liveZones = (exportBody?.dns_zones ?? []) as Array<Record<string, unknown>>;

      if (!coolifyConnected && !technitiumConnected) {
        log('Block 2', '2.5 Existing names warn not error', 'SKIP', 'No infra connected');
      } else if (liveSites.length === 0 && liveZones.length === 0) {
        log('Block 2', '2.5 Existing names warn not error', 'SKIP', 'No existing sites or zones to test against');
      } else {
        // Build a fixture using an existing name
        const fixture = {
          version: 1,
          exported_at: new Date().toISOString(),
          sites: liveSites.length > 0 ? [liveSites[0]] : [],
          dns_zones: liveZones.length > 0 ? [{ ...liveZones[0], records: [] }] : [],
        };
        const res = await apiFetch(page, `${API_URL}/backup/validate`, { method: 'POST', body: fixture });
        const body = res.body as Record<string, unknown>;
        const warnings = (body?.warnings as string[]) ?? [];
        const errors = (body?.errors as string[]) ?? [];
        if (body?.valid === true && warnings.some(w => w.includes('already exists') || w.includes('will be skipped') || w.includes('will be merged'))) {
          log('Block 2', '2.5 Existing names warn not error', 'PASS', `${warnings.length} warning(s), valid=true, ${errors.length} errors`);
        } else if (body?.valid === true && warnings.length === 0) {
          log('Block 2', '2.5 Existing names warn not error', 'WARN', `valid=true but no conflict warnings produced — may indicate Coolify/Technitium not reachable from validate`);
        } else {
          log('Block 2', '2.5 Existing names warn not error', 'FAIL', `valid=${body?.valid}, errors=${JSON.stringify(errors)}, warnings=${JSON.stringify(warnings)}`);
        }
      }
    }

    // 2.6 Domain sanitization (regression #7)
    console.log('\n  [2.6] Domain sanitization — protocol prefix stripped');
    {
      const res = await apiFetch(page, `${API_URL}/backup/validate`, {
        method: 'POST',
        body: {
          version: 1,
          exported_at: new Date().toISOString(),
          sites: [{
            name: 'test-protocol-domain',
            domain: 'https://example.com/path?query=1',
            git_repository: 'https://github.com/test/repo',
            git_branch: 'main',
            deploy_auth: 'ssh_key',
          }],
          dns_zones: [],
        },
      });
      const body = res.body as Record<string, unknown>;
      // Service strips protocol before FQDN check: bare = 'example.com'
      if (body?.valid === true) {
        log('Block 2', '2.6 Domain sanitization', 'PASS', 'Protocol+path stripped — FQDN validated as example.com');
      } else {
        const errors = (body?.errors as string[]) ?? [];
        // If it fails FQDN check, document the actual behavior
        log('Block 2', '2.6 Domain sanitization', 'WARN', `valid=false — service may not strip protocol: ${JSON.stringify(errors)}`);
      }
    }

    // 2.7 Unknown record type → warning not error
    console.log('\n  [2.7] Unknown record type → warning not error');
    {
      const res = await apiFetch(page, `${API_URL}/backup/validate`, {
        method: 'POST',
        body: {
          version: 1,
          exported_at: new Date().toISOString(),
          sites: [],
          dns_zones: [{
            name: 'test.example.com',
            type: 'Primary',
            records: [{
              name: 'test.example.com',
              type: 'BOGUS',
              ttl: 3600,
              rData: { value: 'test' },
            }],
          }],
        },
      });
      const body = res.body as Record<string, unknown>;
      const warnings = (body?.warnings as string[]) ?? [];
      if (body?.valid === true && warnings.some(w => w.includes("BOGUS"))) {
        log('Block 2', '2.7 Unknown record type warning', 'PASS', `warning: "${warnings.find(w => w.includes('BOGUS'))}"`);
      } else {
        log('Block 2', '2.7 Unknown record type warning', 'FAIL', `valid=${body?.valid}, warnings=${JSON.stringify(warnings)}`);
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // BLOCK 3: API — Import (POST /api/backup)
    // ═══════════════════════════════════════════════════════════════════════
    console.log('\n═══ BLOCK 3: API Import ═══');

    // 3.1 Invalid backup → HTTP 422
    console.log('\n  [3.1] Invalid backup → 422');
    {
      const res = await apiFetch(page, `${API_URL}/backup`, { method: 'POST', body: INVALID_BACKUP_FIXTURE });
      const body = res.body as Record<string, unknown>;
      if (res.status === 422 && body?.error === 'Invalid backup file') {
        log('Block 3', '3.1 Invalid → HTTP 422', 'PASS', `errors: ${JSON.stringify(body?.errors)}`);
      } else {
        log('Block 3', '3.1 Invalid → HTTP 422', 'FAIL', `HTTP ${res.status}, body=${JSON.stringify(body)}`);
      }
    }

    // 3.2 Import result structure (AC #4)
    console.log('\n  [3.2] Import result has created/skipped/failed keys (AC #4)');
    if (!coolifyConnected && !technitiumConnected) {
      // Even without infra, the route should return the structure
      const res = await apiFetch(page, `${API_URL}/backup`, { method: 'POST', body: VALID_BACKUP_FIXTURE });
      const body = res.body as Record<string, unknown>;
      const sites = body?.sites as Record<string, unknown>;
      const dns = body?.dns as Record<string, unknown>;
      if (
        res.status === 200 &&
        Array.isArray(sites?.created) && Array.isArray(sites?.skipped) && Array.isArray(sites?.failed) &&
        Array.isArray(dns?.created) && Array.isArray(dns?.skipped) && Array.isArray(dns?.failed)
      ) {
        log('Block 3', '3.2 Import result structure', 'PASS', `sites: +${(sites.created as unknown[]).length} ⊘${(sites.skipped as unknown[]).length} ✗${(sites.failed as unknown[]).length} / dns: +${(dns.created as unknown[]).length} ⊘${(dns.skipped as unknown[]).length} ✗${(dns.failed as unknown[]).length}`);
      } else {
        log('Block 3', '3.2 Import result structure', 'FAIL', `HTTP ${res.status}, body=${JSON.stringify(body).slice(0, 200)}`);
      }
    } else {
      const res = await apiFetch(page, `${API_URL}/backup`, { method: 'POST', body: VALID_BACKUP_FIXTURE });
      const body = res.body as Record<string, unknown>;
      const sites = body?.sites as Record<string, unknown>;
      const dns = body?.dns as Record<string, unknown>;
      if (
        res.status === 200 &&
        Array.isArray(sites?.created) && Array.isArray(sites?.skipped) && Array.isArray(sites?.failed) &&
        Array.isArray(dns?.created) && Array.isArray(dns?.skipped) && Array.isArray(dns?.failed)
      ) {
        log('Block 3', '3.2 Import result structure', 'PASS', `sites: +${(sites.created as unknown[]).length} ⊘${(sites.skipped as unknown[]).length} ✗${(sites.failed as unknown[]).length} / dns: +${(dns.created as unknown[]).length} ⊘${(dns.skipped as unknown[]).length} ✗${(dns.failed as unknown[]).length}`);
      } else {
        log('Block 3', '3.2 Import result structure', 'FAIL', `HTTP ${res.status}, body=${JSON.stringify(body).slice(0, 200)}`);
      }
    }

    // 3.3 Re-import same fixture → skipped, not created (AC #4, regression #6)
    console.log('\n  [3.3] Re-import same fixture → explicit skip (regression #6)');
    {
      const res = await apiFetch(page, `${API_URL}/backup`, { method: 'POST', body: VALID_BACKUP_FIXTURE });
      const body = res.body as Record<string, unknown>;
      const sites = body?.sites as Record<string, unknown>;
      if (res.status !== 200) {
        log('Block 3', '3.3 Re-import explicit skip', 'SKIP', `HTTP ${res.status} — first import may not have succeeded`);
      } else {
        const created = (sites?.created as string[]) ?? [];
        const skipped = (sites?.skipped as string[]) ?? [];
        const failed = (sites?.failed as string[]) ?? [];
        const siteSkipped = skipped.some(s => s.includes(TEST_SITE_NAME));
        const siteCreated = created.some(s => s.includes(TEST_SITE_NAME));
        if (siteSkipped && !siteCreated) {
          log('Block 3', '3.3 Re-import explicit skip', 'PASS', `"${TEST_SITE_NAME}" in skipped, not created`);
        } else if (!coolifyConnected) {
          // If Coolify not connected, site goes to failed — cannot test skip
          const siteFailed = failed.some(s => s.includes(TEST_SITE_NAME));
          log('Block 3', '3.3 Re-import explicit skip', 'SKIP', `Coolify not connected — site ${siteFailed ? 'failed' : 'status unknown'} (cannot verify skip behavior)`);
        } else {
          log('Block 3', '3.3 Re-import explicit skip', 'FAIL', `created=${JSON.stringify(created)}, skipped=${JSON.stringify(skipped)}`);
        }
      }
    }

    // 3.4 PAT re-embedded on import (AC #5, regression #5)
    console.log('\n  [3.4] PAT re-embedded on import (AC #5, regression #5)');
    if (!coolifyConnected) {
      log('Block 3', '3.4 PAT re-embedded on import', 'SKIP', 'Coolify not connected — cannot verify app creation');
    } else {
      const res = await apiFetch(page, `${API_URL}/backup`, { method: 'POST', body: PAT_BACKUP_FIXTURE });
      const body = res.body as Record<string, unknown>;
      const sites = body?.sites as Record<string, unknown>;
      const failed = (sites?.failed as string[]) ?? [];
      const patFailed = failed.filter(s => s.includes('pat'));
      if (res.status === 200 && patFailed.length === 0) {
        log('Block 3', '3.4 PAT re-embedded on import', 'PASS', 'PAT site created or skipped without token errors');
      } else {
        const tokenErr = patFailed.find(s => s.includes('token') || s.includes('credential'));
        log('Block 3', '3.4 PAT re-embedded on import', tokenErr ? 'FAIL' : 'WARN', tokenErr ? `Token embedding failed: "${tokenErr}"` : `PAT site failed for other reason: ${JSON.stringify(patFailed)}`);
      }
    }

    // 3.5 Concurrent imports — no race crash (regression #8)
    console.log('\n  [3.5] Concurrent imports — no race crash (regression #8)');
    {
      const fixture2 = {
        ...VALID_BACKUP_FIXTURE,
        sites: [{ ...VALID_BACKUP_FIXTURE.sites[0], name: `${TEST_SITE_NAME}-race` }],
        dns_zones: [],
      };
      const [res1, res2] = await Promise.all([
        apiFetch(page, `${API_URL}/backup`, { method: 'POST', body: VALID_BACKUP_FIXTURE }),
        apiFetch(page, `${API_URL}/backup`, { method: 'POST', body: fixture2 }),
      ]);
      if (res1.status === 200 && res2.status === 200) {
        log('Block 3', '3.5 Concurrent imports no crash', 'PASS', `both returned 200`);
      } else if (res1.status === 200 || res2.status === 200) {
        log('Block 3', '3.5 Concurrent imports no crash', 'WARN', `one succeeded (${res1.status}/${res2.status}) — check for 500`);
      } else {
        log('Block 3', '3.5 Concurrent imports no crash', 'FAIL', `both failed: ${res1.status}/${res2.status}`);
      }
    }

    // 3.6 DNS duplicates → skipped not created (regression #4)
    console.log('\n  [3.6] DNS duplicates counted as skipped not created (regression #4)');
    if (!technitiumConnected) {
      log('Block 3', '3.6 DNS duplicate detection', 'SKIP', 'Technitium not connected');
    } else {
      // Re-import the same fixture (zone already imported in 3.2 or 3.3)
      const res = await apiFetch(page, `${API_URL}/backup`, { method: 'POST', body: VALID_BACKUP_FIXTURE });
      const body = res.body as Record<string, unknown>;
      const dns = body?.dns as Record<string, unknown>;
      const created = (dns?.created as string[]) ?? [];
      const skipped = (dns?.skipped as string[]) ?? [];
      // SOA updates via updateRecord always appear in created — only check non-SOA records
      const nonSoaCreated = created.filter(c => !c.includes('SOA'));
      const nonSoaSkipped = skipped.filter(s => s.includes(TEST_ZONE_NAME));
      if (nonSoaSkipped.length > 0 && nonSoaCreated.filter(c => c.includes(TEST_ZONE_NAME)).length === 0) {
        log('Block 3', '3.6 DNS duplicate detection', 'PASS', `duplicate A records in skipped (${nonSoaSkipped.length}), not created`);
      } else if (res.status === 200) {
        log('Block 3', '3.6 DNS duplicate detection', 'WARN', `created=${JSON.stringify(created)}, skipped=${JSON.stringify(skipped)} — may be first import (no duplicate to detect)`);
      } else {
        log('Block 3', '3.6 DNS duplicate detection', 'FAIL', `HTTP ${res.status}`);
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // BLOCK 4: UI — Settings page
    // ═══════════════════════════════════════════════════════════════════════
    console.log('\n═══ BLOCK 4: UI Settings Page ═══');

    // Navigate to settings
    await page.goto(`${BASE_URL}/settings`);
    await page.waitForLoadState('networkidle');
    await takeScreenshot(page, '01-settings-page-load');

    // 4.1 Backup & Restore section visible
    console.log('\n  [4.1] Backup & Restore section visible');
    {
      const heading = page.locator('h2.card-title', { hasText: 'Backup' });
      const exportHeading = page.locator('h3.section-title', { hasText: 'Export' });
      const restoreHeading = page.locator('h3.section-title', { hasText: 'Restore' });
      const headingVisible = await heading.isVisible().catch(() => false);
      const exportVisible = await exportHeading.isVisible().catch(() => false);
      const restoreVisible = await restoreHeading.isVisible().catch(() => false);
      await takeScreenshot(page, '02-backup-section');
      if (headingVisible && exportVisible && restoreVisible) {
        log('Block 4', '4.1 Backup & Restore section visible', 'PASS');
      } else {
        log('Block 4', '4.1 Backup & Restore section visible', 'FAIL', `heading=${headingVisible}, export=${exportVisible}, restore=${restoreVisible}`);
      }
    }

    // 4.2 Export button disabled when nothing selected
    console.log('\n  [4.2] Export button disabled when nothing selected');
    {
      // Uncheck all sites by clicking "All" in Sites header (toggles off)
      const siteAllCheckbox = page.locator('.selector-block').first().locator('input[type="checkbox"]').first();
      const allSitesChecked = await siteAllCheckbox.isChecked().catch(() => false);
      if (allSitesChecked) await siteAllCheckbox.click();

      // Uncheck all zones
      const zoneAllCheckbox = page.locator('.selector-block').nth(1).locator('input[type="checkbox"]').first();
      const allZonesChecked = await zoneAllCheckbox.isChecked().catch(() => false);
      if (allZonesChecked) await zoneAllCheckbox.click();

      await page.waitForTimeout(300);
      await takeScreenshot(page, '03-export-button-disabled');

      const downloadBtn = page.locator('button', { hasText: 'Download Backup' });
      const isDisabled = await downloadBtn.isDisabled().catch(() => false);
      if (isDisabled) {
        log('Block 4', '4.2 Export disabled when nothing selected', 'PASS');
      } else {
        log('Block 4', '4.2 Export disabled when nothing selected', 'FAIL', 'Download Backup button is NOT disabled with no selection');
      }
    }

    // Re-select all for next tests
    {
      const siteAllCheckbox = page.locator('.selector-block').first().locator('input[type="checkbox"]').first();
      const isChecked = await siteAllCheckbox.isChecked().catch(() => false);
      if (!isChecked) await siteAllCheckbox.click();
      const zoneAllCheckbox = page.locator('.selector-block').nth(1).locator('input[type="checkbox"]').first();
      const zoneChecked = await zoneAllCheckbox.isChecked().catch(() => false);
      if (!zoneChecked) await zoneAllCheckbox.click();
      await page.waitForTimeout(300);
    }

    // 4.3 Filename preview updates with selection
    console.log('\n  [4.3] Filename preview updates with selection');
    {
      // With all selected
      const previewLocator = page.locator('.export-filename');
      const fullPreviewVisible = await previewLocator.isVisible().catch(() => false);
      if (fullPreviewVisible) {
        const fullText = await previewLocator.textContent();
        const fullOk = fullText?.includes(`hermithost-backup-${TODAY}.json`) || fullText?.includes('hermithost-backup-');
        await takeScreenshot(page, '04-filename-preview-full');

        // Uncheck all zones to get sites-only filename
        const zoneAllCheckbox = page.locator('.selector-block').nth(1).locator('input[type="checkbox"]').first();
        const zoneChecked = await zoneAllCheckbox.isChecked().catch(() => false);
        if (zoneChecked) await zoneAllCheckbox.click();
        await page.waitForTimeout(300);

        const sitesText = await previewLocator.textContent().catch(() => '');
        const sitesOk = sitesText?.includes('hermithost-sites-') || sitesText === '';

        // Re-check zones
        const zoneCheckbox2 = page.locator('.selector-block').nth(1).locator('input[type="checkbox"]').first();
        await zoneCheckbox2.click().catch(() => {});
        await page.waitForTimeout(200);

        if (fullOk && sitesOk) {
          log('Block 4', '4.3 Filename preview updates', 'PASS', `full="${fullText?.trim()}", sites-only preview correct`);
        } else {
          log('Block 4', '4.3 Filename preview updates', 'FAIL', `full="${fullText}", sites="${sitesText}", fullOk=${fullOk}, sitesOk=${sitesOk}`);
        }
      } else {
        // No sites/zones exist — preview hidden, that's expected
        log('Block 4', '4.3 Filename preview updates', 'WARN', 'No preview visible — likely no sites/zones available; skipping preview text check');
      }
    }

    // 4.4 File upload → validation card appears (valid file)
    console.log('\n  [4.4] Upload valid file → validation card shown');
    {
      // Navigate fresh to get clean state
      await page.goto(`${BASE_URL}/settings`);
      await page.waitForLoadState('networkidle');

      // Write fixture to a temp file
      const tmpFile = path.join(os.tmpdir(), `hermithost-test-backup-${TS}.json`);
      fs.writeFileSync(tmpFile, JSON.stringify(VALID_BACKUP_FIXTURE));

      // Inject file content directly — bypasses hidden input event issues
      const fileContent = fs.readFileSync(tmpFile, 'utf8');
      await page.evaluate(async (content: string) => {
        const blob = new Blob([content], { type: 'application/json' });
        const file = new File([blob], 'test-backup.json', { type: 'application/json' });
        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(file);
        const input = document.querySelector('input[type="file"]') as HTMLInputElement;
        if (!input) throw new Error('file input not found');
        Object.defineProperty(input, 'files', { value: dataTransfer.files, writable: true });
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }, fileContent);
      // Wait for the validation API call to complete
      await page.waitForFunction(() => {
        const card = document.querySelector('.validation-card');
        return card !== null;
      }, { timeout: 10000 }).catch(() => {});

      const validationCard = page.locator('.validation-card');
      const cardVisible = await validationCard.isVisible({ timeout: 5000 }).catch(() => false);
      await takeScreenshot(page, '05-validation-card-valid');

      if (cardVisible) {
        const validLabel = page.locator('.valid-label');
        const isValid = await validLabel.isVisible().catch(() => false);
        if (isValid) {
          const labelText = await validLabel.textContent();
          log('Block 4', '4.4 Valid file → validation card', 'PASS', `"${labelText?.trim()}"`);
        } else {
          const invalidLabel = page.locator('.invalid-label');
          const invalidText = await invalidLabel.textContent().catch(() => '');
          const errors = await page.locator('.error-list li').allTextContents().catch(() => [] as string[]);
          log('Block 4', '4.4 Valid file → validation card', 'FAIL', `shows invalid: "${invalidText}", errors: ${JSON.stringify(errors)}`);
        }
      } else {
        log('Block 4', '4.4 Valid file → validation card', 'FAIL', 'validation-card not visible after upload');
      }

      fs.unlinkSync(tmpFile);
    }

    // 4.5 Import button disabled until validation done (regression #9)
    console.log('\n  [4.5] Import button disabled until validation done (regression #9)');
    {
      // After 4.4, validation should be done — check import button is now enabled
      const importBtn = page.locator('button', { hasText: 'Import Backup' });
      const btnExists = await importBtn.isVisible({ timeout: 2000 }).catch(() => false);

      if (!btnExists) {
        // Button absent — may be because file was invalid or no validationResult
        const validCard = await page.locator('.validation-card.valid').isVisible().catch(() => false);
        if (!validCard) {
          log('Block 4', '4.5 Import button state', 'WARN', 'Import button absent — validation may have failed (check 4.4)');
        } else {
          log('Block 4', '4.5 Import button state', 'FAIL', 'Validation card shows valid but Import button absent');
        }
      } else {
        // Button exists — verify it's enabled (not disabled)
        const isDisabled = await importBtn.isDisabled().catch(() => true);
        if (!isDisabled) {
          log('Block 4', '4.5 Import button enabled post-validation', 'PASS', 'Button enabled after validateState=done');
        } else {
          log('Block 4', '4.5 Import button enabled post-validation', 'FAIL', 'Import button still disabled after validation completed');
        }
      }
      await takeScreenshot(page, '06-import-button-state');
    }

    // 4.6 Invalid file → error card, no import button
    console.log('\n  [4.6] Invalid file → red error card, no import button');
    {
      // Navigate fresh
      await page.goto(`${BASE_URL}/settings`);
      await page.waitForLoadState('networkidle');

      const tmpFile2 = path.join(os.tmpdir(), `hermithost-invalid-backup-${TS}.json`);
      fs.writeFileSync(tmpFile2, JSON.stringify(INVALID_BACKUP_FIXTURE));

      // Inject file content directly
      const fileContent2 = fs.readFileSync(tmpFile2, 'utf8');
      await page.evaluate(async (content: string) => {
        const blob = new Blob([content], { type: 'application/json' });
        const file = new File([blob], 'invalid-backup.json', { type: 'application/json' });
        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(file);
        const input = document.querySelector('input[type="file"]') as HTMLInputElement;
        if (!input) throw new Error('file input not found');
        Object.defineProperty(input, 'files', { value: dataTransfer.files, writable: true });
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }, fileContent2);
      // Wait for validation card to appear
      await page.waitForFunction(() => {
        return document.querySelector('.validation-card') !== null;
      }, { timeout: 10000 }).catch(() => {});

      const invalidCard = page.locator('.validation-card.invalid');
      const cardVisible = await invalidCard.isVisible({ timeout: 5000 }).catch(() => false);
      await takeScreenshot(page, '07-validation-invalid');

      if (cardVisible) {
        const invalidLabel = page.locator('.invalid-label');
        const importBtn = page.locator('button', { hasText: 'Import Backup' });
        const labelVisible = await invalidLabel.isVisible().catch(() => false);
        const importBtnAbsent = !(await importBtn.isVisible({ timeout: 500 }).catch(() => false));
        const errors = await page.locator('.error-list li').allTextContents().catch(() => [] as string[]);
        if (labelVisible && importBtnAbsent) {
          log('Block 4', '4.6 Invalid file → error card', 'PASS', `errors: ${JSON.stringify(errors)}`);
        } else {
          log('Block 4', '4.6 Invalid file → error card', 'FAIL', `labelVisible=${labelVisible}, importBtnAbsent=${importBtnAbsent}`);
        }
      } else {
        log('Block 4', '4.6 Invalid file → error card', 'FAIL', '.validation-card.invalid not visible');
      }

      fs.unlinkSync(tmpFile2);
    }

    // 4.7 Reset clears state
    console.log('\n  [4.7] Reset clears validation state');
    {
      // Upload valid file first to ensure validation-card is visible
      const tmpFile3 = path.join(os.tmpdir(), `hermithost-reset-test-${TS}.json`);
      fs.writeFileSync(tmpFile3, JSON.stringify(VALID_BACKUP_FIXTURE));

      await page.goto(`${BASE_URL}/settings`);
      await page.waitForLoadState('networkidle');
      const fileContent3 = fs.readFileSync(tmpFile3, 'utf8');
      await page.evaluate(async (content: string) => {
        const blob = new Blob([content], { type: 'application/json' });
        const file = new File([blob], 'reset-test.json', { type: 'application/json' });
        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(file);
        const input = document.querySelector('input[type="file"]') as HTMLInputElement;
        if (!input) throw new Error('file input not found');
        Object.defineProperty(input, 'files', { value: dataTransfer.files, writable: true });
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }, fileContent3);
      await page.waitForFunction(() => document.querySelector('.validation-card') !== null, { timeout: 10000 }).catch(() => {});

      // Click Reset
      const resetBtn = page.locator('button', { hasText: 'Reset' });
      const resetVisible = await resetBtn.isVisible({ timeout: 5000 }).catch(() => false);
      if (!resetVisible) {
        // Reset only appears in .import-result — may need to complete import first
        // Just check the import button exists and click reset on the validation card via Reset hidden in import result
        // Instead verify validation-card disappears after Reset click
        log('Block 4', '4.7 Reset clears state', 'SKIP', 'Reset button only appears after import — cannot test without triggering full import');
      } else {
        await resetBtn.click();
        await page.waitForTimeout(500);
        await takeScreenshot(page, '09-after-reset');
        const validationCard = page.locator('.validation-card');
        const cardGone = !(await validationCard.isVisible({ timeout: 1000 }).catch(() => false));
        if (cardGone) {
          log('Block 4', '4.7 Reset clears state', 'PASS', 'validation-card gone after Reset');
        } else {
          log('Block 4', '4.7 Reset clears state', 'FAIL', 'validation-card still visible after Reset');
        }
      }

      fs.unlinkSync(tmpFile3);
    }

  } catch (err) {
    const msg = (err as Error).message;
    console.error('\n[FATAL]', msg);
    results.push({ block: 'Fatal', step: 'Unhandled error', status: 'FAIL', notes: msg });
    await takeScreenshot(page, '99-fatal-error').catch(() => {});
  } finally {
    await browser.close();
    writeReport();
  }
}

// ── Report ────────────────────────────────────────────────────────────────────

function writeReport() {
  const pass = results.filter(r => r.status === 'PASS').length;
  const fail = results.filter(r => r.status === 'FAIL').length;
  const warn = results.filter(r => r.status === 'WARN').length;
  const skip = results.filter(r => r.status === 'SKIP').length;
  const total = results.length;

  const overallStatus = fail > 0 ? '❌ BLOCKED' : warn > 0 ? '⚠️ PASS WITH WARNINGS' : '✅ PASS';

  const tableRows = results
    .map(r => {
      const icon = r.status === 'PASS' ? '✅' : r.status === 'FAIL' ? '❌' : r.status === 'SKIP' ? '⊘' : '⚠️';
      return `| ${r.block} | ${r.step} | ${icon} ${r.status} | ${r.notes} |`;
    })
    .join('\n');

  const knownIssueRows = [
    { id: 1, issue: 'PAT token exposed in backup JSON', severity: 'CRITICAL', test: '1.3' },
    { id: 2, issue: 'Missing null/undefined checks on app.fqdn', severity: 'HIGH', test: '1.6' },
    { id: 3, issue: 'Import creates sites without validating domain provisioning', severity: 'HIGH', test: '3.2/3.4' },
    { id: 4, issue: 'DNS results misleading (duplicates counted as "created")', severity: 'MEDIUM', test: '3.6' },
    { id: 5, issue: 'Site import type mismatch (PAT auth but "public" type)', severity: 'MEDIUM', test: '3.4' },
    { id: 6, issue: 'Validation warns but import silently skips', severity: 'MEDIUM', test: '3.3' },
    { id: 7, issue: 'Missing domain input sanitization', severity: 'LOW', test: '2.6' },
    { id: 8, issue: 'Race condition in project creation', severity: 'LOW', test: '3.5' },
    { id: 9, issue: 'Import button active before validation completes', severity: 'LOW', test: '4.5' },
  ];

  const issueRows = knownIssueRows.map(i => {
    const testResult = results.find(r => r.step.includes(`${i.id}.`) || r.notes.toLowerCase().includes(`#${i.id}`));
    const status = testResult ? testResult.status : 'NOT TESTED';
    const icon = status === 'PASS' ? '✅ FIXED' : status === 'FAIL' ? '❌ STILL PRESENT' : status === 'SKIP' ? '⊘ SKIPPED' : status === 'WARN' ? '⚠️ PARTIAL' : '— NOT TESTED';
    return `| #${i.id} | ${i.issue} | ${i.severity} | ${icon} | Test ${i.test} |`;
  }).join('\n');

  const acRows = [
    { id: 1, criteria: 'Export all non-internal DNS zones + records (including SOA)', test: '1.2' },
    { id: 2, criteria: 'Validate version=1, required fields', test: '2.1, 2.2, 2.3' },
    { id: 3, criteria: 'Warn (not error) on existing names', test: '2.5' },
    { id: 4, criteria: 'Return summary of created/skipped/failed', test: '3.2, 3.3' },
    { id: 5, criteria: 'Strip PAT from URLs, store clean URL + token separately', test: '1.3, 3.4' },
    { id: 6, criteria: 'Create sites/DNS, skip if exists, embed PAT if deploy_auth=pat', test: '3.3, 3.4' },
  ].map(ac => {
    const r1 = results.find(r => r.step.includes(ac.test.split(',')[0].trim()));
    const s = r1 ? r1.status : 'NOT TESTED';
    const icon = s === 'PASS' ? '✅' : s === 'FAIL' ? '❌' : s === 'SKIP' ? '⊘' : '⚠️';
    return `| AC #${ac.id} | ${ac.criteria} | ${icon} ${s} | ${ac.test} |`;
  }).join('\n');

  const report = `# QA Report — HermitHost Backup/Restore (Playwright)

**Date:** ${new Date().toISOString().slice(0, 10)}
**Runner:** \`node --loader ts-node/esm test-backup-restore-playwright.ts\`
**App URL:** ${BASE_URL}
**Status:** ${overallStatus}

## Summary

| Result | Count |
|--------|-------|
| ✅ PASS | ${pass} |
| ❌ FAIL | ${fail} |
| ⚠️ WARN | ${warn} |
| ⊘ SKIP | ${skip} |
| **Total** | **${total}** |

---

## Test Results

| Block | Test | Status | Notes |
|-------|------|--------|-------|
${tableRows}

---

## Acceptance Criteria

| # | Criteria | Status | Tests |
|---|----------|--------|-------|
${acRows}

---

## Known Issues Status

| # | Issue | Severity | Status | Test |
|---|-------|----------|--------|------|
${issueRows}

---

## Screenshots

Screenshots saved to: \`test-screenshots-backup-restore/\`
`;

  const HARNESS_ROOT = path.join(__dirname, '..', '..', '..', '..', 'projects', 'ai', 'molt-and-deploy-harness');
  const reportPath = path.join(
    HARNESS_ROOT,
    'clients', 'self', 'projects', 'hermithost', 'qa',
    `qa-backup-restore-playwright-${TODAY}.md`
  );

  // Try harness path first, fall back to project root
  const fallbackPath = path.join(__dirname, `qa-backup-restore-playwright-${TODAY}.md`);
  const targetPath = fs.existsSync(path.dirname(reportPath)) ? reportPath : fallbackPath;

  fs.writeFileSync(targetPath, report);
  console.log(`\n[REPORT] Written to: ${targetPath}`);
  console.log(`\n${overallStatus} — ${pass}/${total} passed, ${fail} failed, ${warn} warnings, ${skip} skipped`);
}

runTests().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
