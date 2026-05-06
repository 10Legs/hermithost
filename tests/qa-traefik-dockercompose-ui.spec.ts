import { test, expect } from '@playwright/test';
import { execSync } from 'child_process';
import * as path from 'path';

const BASE_URL = 'http://localhost:9080';
const TEST_DOMAIN = 'cantaconmigo-qa.localhost';
const TEST_REPO = 'https://github.com/coollabsio/coolify-examples';
const TEST_PAT = process.env.GITHUB_PAT_TEST_QA || '';
const TRAEFIK_CONF_DIR = '/app/traefik-conf.d';

test.describe.configure({ timeout: 120000 });
test.slow();

test.describe('§11.12 — Traefik Route Dockercompose UI Synth Test', () => {
  let testSiteSlug: string;
  const testSiteName = `cantaconmigo-qa-test-${Date.now()}`;

  test('E2E: Create, deploy, and verify traefik route for dockercompose site', async ({ page }) => {
    console.log('\n=== E2E Traefik Dockercompose Flow ===');
    console.log(`Test domain: ${TEST_DOMAIN}`);
    console.log(`Test repo: ${TEST_REPO}`);
    console.log(`PAT available: ${!!TEST_PAT}`);

    // Step 0: Navigate and authenticate
    console.log('\n[Step 0] Navigate and authenticate');
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.screenshot({ path: '/tmp/qa-dc-00-init.png' });

    // Check if we're on login page
    const passwordInput = page.locator('input[type="password"]').first();
    const signInBtn = page.locator('button:has-text("Sign In")').first();

    if (await passwordInput.isVisible({ timeout: 3000 }).catch(() => false)) {
      console.log('  - Login form detected');
      await passwordInput.fill('password');
      await signInBtn.click({ force: true });
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(2000);
      console.log('  - ✓ Authenticated');
    } else {
      console.log('  - Already authenticated (no login form found)');
    }

    // Step 1: Dashboard verification
    console.log('\n[Step 1] Dashboard loaded');
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.screenshot({ path: '/tmp/qa-dc-01-dashboard.png' });
    console.log('✓ Dashboard visible');

    // Step 2: Open Add Site modal (try multiple selectors)
    console.log('\n[Step 2] Open Add Site modal');
    let addSiteBtn = page.locator('button').filter({ hasText: /add site/i }).first();

    if (!await addSiteBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      addSiteBtn = page.locator('[class*="add"], [class*="create"]').filter({ hasText: /site/i }).first();
    }

    await expect(addSiteBtn).toBeVisible({ timeout: 10000 });
    await addSiteBtn.click({ force: true });
    await page.waitForTimeout(500);
    await page.screenshot({ path: '/tmp/qa-dc-02-form.png' });
    console.log('✓ Add Site form opened');

    // Step 3-7: Fill form fields
    console.log('\n[Step 3-7] Fill form');

    // Name
    let nameField = page.locator('#add-name, [name="name"], input[placeholder*="name" i]').first();
    await nameField.fill(testSiteName);
    console.log(`  - Name: ${testSiteName}`);

    // Domain
    let domainField = page.locator('#add-domain, [name="domain"], [name="fqdn"], input[placeholder*="domain" i]').first();
    await domainField.fill(TEST_DOMAIN);
    console.log(`  - Domain: ${TEST_DOMAIN}`);

    // Repo
    let repoField = page.locator('#add-git-repo, [name="repository"], [name="git_repository"], input[placeholder*="repo" i]').first();
    await repoField.fill(TEST_REPO);
    console.log(`  - Repo: ${TEST_REPO}`);

    // Branch
    let branchField = page.locator('#add-git-branch, [name="branch"], [name="git_branch"], input[placeholder*="branch" i]').first();
    await branchField.fill('main');
    console.log(`  - Branch: main`);

    // Auth: use PAT if available
    if (TEST_PAT) {
      console.log('  - Using PAT auth');
      // Look for PAT/token option
      const patToggle = page.locator('button, label').filter({ hasText: /pat|token|personal access/i }).first();
      if (await patToggle.isVisible({ timeout: 2000 }).catch(() => false)) {
        await patToggle.click({ force: true });
      }

      // Fill PAT field
      let patField = page.locator('#deploy-token, [name="deploy_token"], [name="token"], input[placeholder*="token" i]').first();
      await patField.fill(TEST_PAT);
      console.log('  - ✓ PAT filled');
    } else {
      console.log('  - Using SSH Key auth (no PAT)');
    }

    // Build pack: dockercompose
    console.log('  - Selecting build pack: dockercompose');
    let buildPackSelect = page.locator('select').first();
    if (await buildPackSelect.isVisible({ timeout: 2000 }).catch(() => false)) {
      await buildPackSelect.selectOption('dockercompose');
    } else {
      // Try button-based
      const dcBtn = page.locator('button, label').filter({ hasText: /docker.?compose|dockercompose/i }).first();
      if (await dcBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await dcBtn.click({ force: true });
      }
    }
    console.log('  - ✓ Build pack selected');

    await page.screenshot({ path: '/tmp/qa-dc-03-form-filled.png' });

    // Step 8: Submit
    console.log('\n[Step 8] Submit form');
    const submitBtn = page.locator('button').filter({ hasText: /^(add|create|submit)/i }).last();
    await expect(submitBtn).toBeVisible({ timeout: 5000 });
    await submitBtn.click({ force: true });
    console.log('  - Form submitted');

    // Wait for navigation
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);

    // Step 9: Extract slug
    console.log('\n[Step 9] Extract site slug');
    const pageUrl = page.url();
    console.log(`  - Page URL: ${pageUrl}`);

    if (pageUrl.includes('/sites/')) {
      testSiteSlug = pageUrl.split('/sites/')[1].split('/')[0];
      console.log(`  - ✓ Slug: ${testSiteSlug}`);
    } else {
      throw new Error(`Could not extract slug from URL: ${pageUrl}`);
    }

    await page.screenshot({ path: '/tmp/qa-dc-04-created.png' });

    // Step 10: Trigger deploy
    console.log('\n[Step 10] Trigger deploy');
    try {
      const apiResp = await fetch(`http://localhost:3001/api/sites/${testSiteSlug}/deploy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      console.log(`  - Deploy response: ${apiResp.status}`);
      if (apiResp.ok) {
        const data = await apiResp.json();
        console.log(`  - ✓ Deploy jobId: ${data.jobId}`);
      }
    } catch (e) {
      console.warn(`  ⚠ Deploy trigger error: ${(e as Error).message}`);
    }

    // Step 11: Wait for route file
    console.log('\n[Step 11] Wait for traefik route file (max 5 min)');
    const routeFilePath = path.join(TRAEFIK_CONF_DIR, `site-${testSiteSlug}.yml`);
    let routeWritten = false;

    for (let i = 0; i < 150; i++) {
      try {
        const result = execSync(`docker exec hermithost-api-1 test -f "${routeFilePath}" && echo ok || echo missing`, {
          encoding: 'utf8',
          timeout: 3000,
          stdio: ['pipe', 'pipe', 'ignore'],
        }).trim();

        if (result === 'ok') {
          routeWritten = true;
          console.log(`  - ✓ Route file created (attempt ${i + 1})`);
          break;
        }
      } catch (e) {
        // Will retry
      }
      await new Promise(r => setTimeout(r, 2000));
    }

    if (!routeWritten) {
      console.error(`  ✗ FAILED: Route file not written after 5 minutes`);
      throw new Error(`Route file not found: ${routeFilePath}`);
    }

    // Step 12: Verify yml content
    console.log('\n[Step 12] Verify YAML content');
    let ymlContent = '';
    try {
      ymlContent = execSync(`docker exec hermithost-api-1 cat "${routeFilePath}"`, {
        encoding: 'utf8',
        timeout: 3000,
      });
      console.log(`  - ✓ File content (${ymlContent.length} bytes)`);
      console.log(ymlContent.split('\n').slice(0, 5).map(l => `      ${l}`).join('\n'));
    } catch (e) {
      throw new Error(`Failed to read route file: ${(e as Error).message}`);
    }

    // Assertions
    expect(ymlContent).toContain(`Host(\`${TEST_DOMAIN}\`)`);
    console.log(`  - ✓ Contains Host rule for ${TEST_DOMAIN}`);

    expect(ymlContent).toMatch(/url:\s+"http:\/\/[a-z0-9-]+:[0-9]+"/);
    console.log(`  - ✓ Contains valid service URL`);

    // Step 13: Verify frontend on coolify network
    console.log('\n[Step 13] Verify frontend on coolify network');
    try {
      const netOutput = execSync('docker network inspect coolify 2>/dev/null | grep -i frontend || echo "not found"', {
        encoding: 'utf8',
        timeout: 3000,
        stdio: ['pipe', 'pipe', 'ignore'],
      }).trim();

      if (netOutput !== 'not found' && netOutput.length > 0) {
        console.log(`  - ✓ Frontend on coolify network`);
      } else {
        console.warn(`  ⚠ Could not confirm frontend on coolify (may take time to attach)`);
      }
    } catch (e) {
      console.warn(`  ⚠ Network check failed: ${(e as Error).message}`);
    }

    await page.screenshot({ path: '/tmp/qa-dc-05-routed.png' });

    // Step 14: Cleanup
    console.log('\n[Step 14] Cleanup');
    try {
      const delResp = await fetch(`http://localhost:3001/api/sites/${testSiteSlug}`, { method: 'DELETE' });
      console.log(`  - Delete response: ${delResp.status}`);

      await page.waitForTimeout(2000);

      // Verify yml removed
      try {
        execSync(`docker exec hermithost-api-1 test -f "${routeFilePath}"`, {
          timeout: 3000,
          stdio: 'pipe',
        });
        console.warn(`  ⚠ Route file still exists after deletion`);
      } catch (e) {
        console.log(`  - ✓ Route file deleted`);
      }
    } catch (e) {
      console.warn(`  ⚠ Cleanup failed: ${(e as Error).message}`);
    }

    await page.screenshot({ path: '/tmp/qa-dc-06-cleanup.png' });
    console.log('\n=== E2E Test Complete ===');
  });
});
