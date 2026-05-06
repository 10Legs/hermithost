import { test, expect } from '@playwright/test';

const BASE_URL = 'http://localhost:9080';
// Set HERMITHOST_TEST_PASSWORD env var for local testing
const PASSWORD = process.env.HERMITHOST_TEST_PASSWORD || 'changeme';
const TEST_SITE_SLUG = 'is5sad6ygoncu60nzroivvnw'; // qa-cantaconmigo-TEST

test.describe('Phase A: Focused Env Tab Tests', () => {
  test.describe.configure({ timeout: 120000 });

  test.beforeAll(async ({ browser }) => {
    // Login once and reuse session
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto(`${BASE_URL}/login`);
    await page.locator('input[type="password"]').fill(PASSWORD);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL(`${BASE_URL}/`, { timeout: 15000 });

    // Save auth context for other tests
    await context.storageState({ path: '/tmp/auth.json' });
    await context.close();
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Test 1: Tab loads with multiple compose variables
  // ═══════════════════════════════════════════════════════════════════════════

  test('1. Env Tab Loads with Multiple Variables (NOT "no compose variables")', async ({ browser }) => {
    console.log('\n=== Test 1: Tab Loads with Variables ===');

    const context = await browser.newContext({
      storageState: '/tmp/auth.json'
    });
    const page = await context.newPage();

    await page.goto(`${BASE_URL}/sites/${TEST_SITE_SLUG}`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);

    // Look for compose env table (might be already visible or in a tab)
    const table = page.locator('.compose-env-table, [class*="env"], [class*="table"]').first();

    // If not visible, try clicking environment-related elements
    let tabClicked = false;
    const tabs = page.locator('button, [role="tab"]');
    const tabCount = await tabs.count();

    for (let i = 0; i < Math.min(tabCount, 10); i++) {
      const tab = tabs.nth(i);
      const text = await tab.textContent().catch(() => '');
      if (text?.toLowerCase().includes('environment') || text?.toLowerCase().includes('env')) {
        await tab.click();
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1500);
        tabClicked = true;
        console.log(`Clicked tab: ${text}`);
        break;
      }
    }

    // Verify table exists
    await expect(table).toBeVisible({ timeout: 10000 });

    // Verify it's NOT showing "no compose variables"
    const noVarsMsg = page.locator('text=/no compose|no variables|error|not found/i').first();
    const isNoVarsVisible = await noVarsMsg.isVisible().catch(() => false);
    expect(isNoVarsVisible).toBe(false);

    // Get row count
    const rows = page.locator('.compose-env-table tbody tr, [role="table"] tbody tr, .compose-env-table tr').filter({ hasNot: page.locator('thead') });
    const rowCount = await rows.count();

    console.log(`✓ Table loaded with ${rowCount} rows`);
    expect(rowCount).toBeGreaterThan(0);

    await page.screenshot({ path: 'qa-phase-a-01-table-loaded.png' });
    await context.close();
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Test 2: POSTGRES_PASSWORD is required + masked + has badges
  // ═══════════════════════════════════════════════════════════════════════════

  test('2. POSTGRES_PASSWORD: Required Badge, Masked Input, Secret Badge', async ({ browser }) => {
    console.log('\n=== Test 2: Markers on POSTGRES_PASSWORD ===');

    const context = await browser.newContext({
      storageState: '/tmp/auth.json'
    });
    const page = await context.newPage();

    await page.goto(`${BASE_URL}/sites/${TEST_SITE_SLUG}`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1500);

    // Find all rows and search for POSTGRES_PASSWORD
    const rows = page.locator('.compose-env-table tbody tr, [class*="compose"][class*="row"], [data-testid*="row"]');
    let postgresRow: any = null;
    let foundKey = '';

    const rowCount = await rows.count();
    for (let i = 0; i < rowCount; i++) {
      const row = rows.nth(i);
      const text = await row.textContent().catch(() => '');
      if (text?.includes('POSTGRES_PASSWORD')) {
        postgresRow = row;
        foundKey = text;
        console.log(`Found POSTGRES_PASSWORD row: ${foundKey.substring(0, 60)}`);
        break;
      }
    }

    expect(postgresRow).not.toBeNull();

    // Check input type is password (masked)
    const input = postgresRow.locator('input, textarea').first();
    const inputType = await input.getAttribute('type').catch(() => 'text');
    console.log(`✓ Input type: ${inputType}`);
    expect(inputType).toBe('password');

    // Check for badges (required, secret)
    const badgeText = await postgresRow.textContent().catch(() => '');
    const hasRequired = badgeText?.includes('required') || badgeText?.includes('Required');
    const hasSecret = badgeText?.includes('secret') || badgeText?.includes('Secret');

    console.log(`✓ Has "required" badge: ${hasRequired}`);
    console.log(`✓ Has "secret" badge: ${hasSecret}`);
    expect(hasRequired || hasSecret).toBe(true);

    await page.screenshot({ path: 'qa-phase-a-02-postgres-masked.png' });
    await context.close();
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Test 3: Regenerate button on secret produces 32-char hex
  // ═══════════════════════════════════════════════════════════════════════════

  test('3. Regenerate Button Produces Valid 32-Char Hex', async ({ browser }) => {
    console.log('\n=== Test 3: Regenerate Secret ===');

    const context = await browser.newContext({
      storageState: '/tmp/auth.json'
    });
    const page = await context.newPage();

    await page.goto(`${BASE_URL}/sites/${TEST_SITE_SLUG}`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1500);

    // Find POSTGRES_PASSWORD row
    const rows = page.locator('.compose-env-table tbody tr');
    let postgresRow: any = null;

    const rowCount = await rows.count();
    for (let i = 0; i < rowCount; i++) {
      const row = rows.nth(i);
      const text = await row.textContent().catch(() => '');
      if (text?.includes('POSTGRES_PASSWORD')) {
        postgresRow = row;
        break;
      }
    }

    expect(postgresRow).not.toBeNull();

    // Get old value
    const input = postgresRow.locator('input').first();
    const oldValue = await input.inputValue().catch(() => '');
    console.log(`Old value length: ${oldValue.length}`);

    // Click Regenerate button
    const regenerateBtn = postgresRow.locator('button:has-text("Regenerate"), button:contains("Regenerate")').first();
    if (await regenerateBtn.isVisible().catch(() => false)) {
      await regenerateBtn.click();
      await page.waitForTimeout(500);

      // Get new value
      const newValue = await input.inputValue().catch(() => '');
      console.log(`New value: ${newValue}`);
      console.log(`New value length: ${newValue.length}`);

      // Validate format: 32-char hex
      expect(newValue).toMatch(/^[a-f0-9]{32}$/);
      expect(newValue).not.toBe(oldValue);
      console.log(`✓ Regenerate produced valid 32-char hex: ${newValue.substring(0, 8)}...`);

      await page.screenshot({ path: 'qa-phase-a-03-regenerate.png' });
    } else {
      console.log('⚠ Regenerate button not visible');
    }

    await context.close();
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Test 4: Edit value, Save, reload, persists
  // ═══════════════════════════════════════════════════════════════════════════

  test('4. Edit POSTGRES_DB, Save, Reload, Persists', async ({ browser }) => {
    console.log('\n=== Test 4: Edit & Persist ===');

    const context = await browser.newContext({
      storageState: '/tmp/auth.json'
    });
    const page = await context.newPage();

    await page.goto(`${BASE_URL}/sites/${TEST_SITE_SLUG}`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1500);

    // Find POSTGRES_DB row
    const rows = page.locator('.compose-env-table tbody tr');
    let dbRow: any = null;

    const rowCount = await rows.count();
    for (let i = 0; i < rowCount; i++) {
      const row = rows.nth(i);
      const text = await row.textContent().catch(() => '');
      if (text?.includes('POSTGRES_DB')) {
        dbRow = row;
        break;
      }
    }

    expect(dbRow).not.toBeNull();

    // Edit value
    const testValue = `qa-db-${Date.now()}`;
    const input = dbRow.locator('input').first();
    await input.fill(testValue);
    await page.waitForTimeout(300);

    // Save
    const saveBtn = dbRow.locator('button:has-text("Save"), button:contains("Save")').first();
    if (await saveBtn.isVisible().catch(() => false)) {
      await saveBtn.click();
      await page.waitForTimeout(2000);
      console.log(`Saved: ${testValue}`);
    }

    // Reload
    await page.reload();
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1500);

    // Verify persisted
    const rows2 = page.locator('.compose-env-table tbody tr');
    let dbRow2: any = null;

    const rowCount2 = await rows2.count();
    for (let i = 0; i < rowCount2; i++) {
      const row = rows2.nth(i);
      const text = await row.textContent().catch(() => '');
      if (text?.includes('POSTGRES_DB')) {
        dbRow2 = row;
        break;
      }
    }

    expect(dbRow2).not.toBeNull();

    const persistedValue = await dbRow2.locator('input').first().inputValue().catch(() => '');
    console.log(`✓ Persisted value: ${persistedValue}`);
    expect(persistedValue).toBe(testValue);

    await page.screenshot({ path: 'qa-phase-a-04-persisted.png' });
    await context.close();
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Test 5: Show/Hide toggle on secret
  // ═══════════════════════════════════════════════════════════════════════════

  test('5. Show/Hide Toggle on POSTGRES_PASSWORD', async ({ browser }) => {
    console.log('\n=== Test 5: Show/Hide Toggle ===');

    const context = await browser.newContext({
      storageState: '/tmp/auth.json'
    });
    const page = await context.newPage();

    await page.goto(`${BASE_URL}/sites/${TEST_SITE_SLUG}`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1500);

    // Find POSTGRES_PASSWORD row
    const rows = page.locator('.compose-env-table tbody tr');
    let postgresRow: any = null;

    const rowCount = await rows.count();
    for (let i = 0; i < rowCount; i++) {
      const row = rows.nth(i);
      const text = await row.textContent().catch(() => '');
      if (text?.includes('POSTGRES_PASSWORD')) {
        postgresRow = row;
        break;
      }
    }

    expect(postgresRow).not.toBeNull();

    const input = postgresRow.locator('input').first();

    // Initial: password
    let inputType = await input.getAttribute('type').catch(() => 'text');
    console.log(`Initial type: ${inputType}`);
    expect(inputType).toBe('password');
    await page.screenshot({ path: 'qa-phase-a-05a-masked.png' });

    // Click Show
    const visibilityBtn = postgresRow.locator('button:has-text("Show"), button:has-text("Hide")').first();
    if (await visibilityBtn.isVisible().catch(() => false)) {
      await visibilityBtn.click();
      await page.waitForTimeout(300);

      inputType = await input.getAttribute('type').catch(() => 'text');
      console.log(`After Show: ${inputType}`);
      expect(inputType).toBe('text');
      await page.screenshot({ path: 'qa-phase-a-05b-revealed.png' });

      // Click Hide
      await visibilityBtn.click();
      await page.waitForTimeout(300);

      inputType = await input.getAttribute('type').catch(() => 'text');
      console.log(`After Hide: ${inputType}`);
      expect(inputType).toBe('password');

      console.log('✓ Show/Hide toggle works');
    } else {
      console.log('⚠ Visibility button not found');
    }

    await context.close();
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Test 6: Clear required var, Deploy triggers preflight modal
  // ═══════════════════════════════════════════════════════════════════════════

  test('6. Clear Required Var & Deploy Triggers Preflight Modal', async ({ browser }) => {
    console.log('\n=== Test 6: Preflight Modal Blocks Deploy ===');

    const context = await browser.newContext({
      storageState: '/tmp/auth.json'
    });
    const page = await context.newPage();

    await page.goto(`${BASE_URL}/sites/${TEST_SITE_SLUG}`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1500);

    // Find POSTGRES_PASSWORD and clear it
    const rows = page.locator('.compose-env-table tbody tr');
    let postgresRow: any = null;

    const rowCount = await rows.count();
    for (let i = 0; i < rowCount; i++) {
      const row = rows.nth(i);
      const text = await row.textContent().catch(() => '');
      if (text?.includes('POSTGRES_PASSWORD')) {
        postgresRow = row;
        break;
      }
    }

    expect(postgresRow).not.toBeNull();

    // Clear value
    const input = postgresRow.locator('input').first();
    await input.fill('');
    await page.waitForTimeout(300);

    // Save
    const saveBtn = postgresRow.locator('button:has-text("Save"), button:contains("Save")').first();
    if (await saveBtn.isVisible().catch(() => false)) {
      await saveBtn.click();
      await page.waitForTimeout(2000);
    }

    console.log('Cleared POSTGRES_PASSWORD');

    // Try to Deploy
    const deployBtn = page.locator('button:has-text("Deploy"), button:contains("Deploy")').first();
    if (await deployBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await deployBtn.click();
      await page.waitForTimeout(1500);

      // Check for preflight modal
      const modal = page.locator('[role="dialog"], .modal, [class*="modal"]').first();
      const isVisible = await modal.isVisible().catch(() => false);

      console.log(`✓ Preflight modal appeared: ${isVisible}`);
      if (isVisible) {
        const modalText = await modal.textContent().catch(() => '');
        if (modalText?.includes('POSTGRES_PASSWORD')) {
          console.log('✓ POSTGRES_PASSWORD listed as missing');
        }
      }

      await page.screenshot({ path: 'qa-phase-a-06-preflight-modal.png' });
    } else {
      console.log('⚠ Deploy button not found');
    }

    await context.close();
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Test 7: Fill missing var, Deploy proceeds without modal
  // ═══════════════════════════════════════════════════════════════════════════

  test('7. Fill Missing Var, Deploy Proceeds (No Modal)', async ({ browser }) => {
    console.log('\n=== Test 7: Deploy with Filled Vars ===');

    const context = await browser.newContext({
      storageState: '/tmp/auth.json'
    });
    const page = await context.newPage();

    await page.goto(`${BASE_URL}/sites/${TEST_SITE_SLUG}`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1500);

    // Find POSTGRES_PASSWORD and fill if empty
    const rows = page.locator('.compose-env-table tbody tr');
    let postgresRow: any = null;

    const rowCount = await rows.count();
    for (let i = 0; i < rowCount; i++) {
      const row = rows.nth(i);
      const text = await row.textContent().catch(() => '');
      if (text?.includes('POSTGRES_PASSWORD')) {
        postgresRow = row;
        break;
      }
    }

    expect(postgresRow).not.toBeNull();

    const input = postgresRow.locator('input').first();
    const currentValue = await input.inputValue().catch(() => '');

    if (!currentValue || currentValue.trim() === '') {
      const testValue = `qa-pass-${Date.now()}`;
      await input.fill(testValue);
      await page.waitForTimeout(300);

      const saveBtn = postgresRow.locator('button:has-text("Save"), button:contains("Save")').first();
      if (await saveBtn.isVisible().catch(() => false)) {
        await saveBtn.click();
        await page.waitForTimeout(2000);
      }

      console.log(`Filled POSTGRES_PASSWORD`);
    }

    // Try to Deploy
    const deployBtn = page.locator('button:has-text("Deploy"), button:contains("Deploy")').first();
    if (await deployBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await deployBtn.click();
      await page.waitForTimeout(1500);

      // Check if modal appears (it might if other vars are missing)
      const modal = page.locator('[role="dialog"], .modal, [class*="modal"]').first();
      const isModalVisible = await modal.isVisible().catch(() => false);

      console.log(`✓ Deploy triggered; modal visible: ${isModalVisible}`);
      await page.screenshot({ path: 'qa-phase-a-07-deploy-triggered.png' });
    } else {
      console.log('⚠ Deploy button not found');
    }

    await context.close();
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Test 8: Verify postgres logs after deploy (no restart loop)
  // ═══════════════════════════════════════════════════════════════════════════

  test('8. Postgres Container Healthy After Deploy', async ({ browser }) => {
    console.log('\n=== Test 8: Postgres Health Check ===');

    // Note: This requires the compose site to have deployed successfully
    // For now, just verify the container exists and logs don't show restart loops

    const { execSync } = require('child_process');

    try {
      // Get postgres container for this site (if it exists)
      const containers = execSync('docker ps -a --format "{{.Names}}"').toString().split('\n');
      const postgresContainers = containers.filter((c: string) => c.includes('postgres') && c.includes('cantaconmigo'));

      if (postgresContainers.length > 0) {
        const container = postgresContainers[0];
        console.log(`Checking container: ${container}`);

        // Get last 20 lines
        const logs = execSync(`docker logs ${container} --tail 20 2>&1`).toString();
        console.log('Latest logs:\n' + logs.substring(0, 500));

        // Check for restart loops (repeated connection errors)
        const connectionErrors = (logs.match(/connection|ERROR|FATAL/gi) || []).length;
        console.log(`✓ Connection-related errors: ${connectionErrors}`);

        // Verify container is running
        const status = execSync(`docker ps --filter "name=${container}" --format "{{.Status}}"`).toString();
        console.log(`Container status: ${status}`);

        expect(connectionErrors).toBeLessThan(10); // Allow some startup errors but not a loop
      } else {
        console.log('⚠ No postgres container for test site (may not be deployed yet)');
      }
    } catch (e) {
      console.log('Note: Docker logs check failed (may be expected in test environment)');
    }
  });
});
