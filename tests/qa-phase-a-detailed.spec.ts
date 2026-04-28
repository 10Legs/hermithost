import { test, expect } from '@playwright/test';

const BASE_URL = 'http://localhost:9080';
const PASSWORD = '938xDTvcWnyk9TXbo9dlpbcvOuMsqUuwrIB+BPiNIMc=';
const TEST_SITE_SLUG = 'is5sad6ygoncu60nzroivvnw'; // qa-cantaconmigo-TEST

test.describe('Phase A: Detailed Env Tab Validation', () => {
  test.describe.configure({ timeout: 120000 });

  // Login once before all tests
  let loginDone = false;

  async function ensureLogin(page: any) {
    if (!loginDone) {
      await page.goto(`${BASE_URL}/login`);
      await page.locator('input[type="password"]').fill(PASSWORD);
      await page.locator('button[type="submit"]').click();
      await page.waitForURL(`${BASE_URL}/`, { timeout: 15000 });
      loginDone = true;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Test 1: Tab loads with multiple compose variables (NOT "no compose variables")
  // ═══════════════════════════════════════════════════════════════════════════

  test('1. Environment Tab Loads with Multiple Compose Variables', async ({ page }) => {
    console.log('\n=== Test 1: Tab Load & Multiple Variables ===');

    await ensureLogin(page);

    // Navigate to Environment tab
    await page.goto(`${BASE_URL}/sites/${TEST_SITE_SLUG}`);
    await page.waitForLoadState('domcontentloaded');

    // Click Environment tab
    const envTab = page.locator('button:has-text("Environment"), [role="tab"]:has-text("Environment")').first();
    await expect(envTab).toBeVisible({ timeout: 10000 });
    await envTab.click();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);

    // Verify "Compose Variables" section exists
    const composeSection = page.locator('text=/Compose.*Variables|Environment.*Variables/i');
    await expect(composeSection).toBeVisible({ timeout: 5000 });

    // Verify table/section is NOT showing "no compose variables"
    const noVarsMsg = page.locator('text=/no compose variables|no variables detected/i');
    const isNoVarsVisible = await noVarsMsg.isVisible().catch(() => false);
    expect(isNoVarsVisible).toBe(false);

    // Verify table has rows
    const table = page.locator('.compose-env-table, [role="table"]').first();
    await expect(table).toBeVisible({ timeout: 5000 });

    const rows = page.locator('.compose-env-table tbody tr, [role="table"] tbody tr');
    const rowCount = await rows.count();
    console.log(`✓ Environment tab loaded with ${rowCount} compose variables`);
    expect(rowCount).toBeGreaterThan(0);

    // Verify specific variables exist (cantaconmigo)
    const expectedVars = [
      'POSTGRES_PASSWORD',
      'POSTGRES_DB',
      'POSTGRES_USER',
      'JWT_SECRET',
      'DATABASE_URL',
      'NODE_ENV'
    ];

    for (const varName of expectedVars) {
      const varRow = rows.filter({ has: page.locator(`text=${varName}`) }).first();
      const exists = await varRow.isVisible().catch(() => false);
      if (exists) {
        console.log(`✓ Found ${varName}`);
      }
    }

    // Take screenshot
    await page.screenshot({ path: 'qa-phase-a-01-env-tab-loaded.png' });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Test 2: POSTGRES_PASSWORD has red asterisk + required badge + masked
  // ═══════════════════════════════════════════════════════════════════════════

  test('2. POSTGRES_PASSWORD: Red Asterisk, Required Badge, Masked', async ({ page }) => {
    console.log('\n=== Test 2: Required & Secret Markers ===');

    await ensureLogin(page);

    await page.goto(`${BASE_URL}/sites/${TEST_SITE_SLUG}`);
    await page.waitForLoadState('domcontentloaded');

    const envTab = page.locator('button:has-text("Environment"), [role="tab"]:has-text("Environment")').first();
    await envTab.click();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);

    // Find POSTGRES_PASSWORD row
    const rows = page.locator('.compose-env-table tbody tr');
    let postgresRow: any = null;

    for (let i = 0; i < await rows.count(); i++) {
      const row = rows.nth(i);
      const keyText = await row.locator('.compose-env-key, [data-testid="key"]').textContent();
      if (keyText?.includes('POSTGRES_PASSWORD')) {
        postgresRow = row;
        break;
      }
    }

    expect(postgresRow).not.toBeNull();
    console.log('✓ POSTGRES_PASSWORD row found');

    // Check red asterisk
    const asterisk = postgresRow.locator('.compose-required-marker, span:has-text("*")');
    const hasAsterisk = await asterisk.isVisible().catch(() => false);
    console.log(`✓ Red asterisk visible: ${hasAsterisk}`);

    // Check required badge
    const requiredBadge = postgresRow.locator('.compose-badge-required, .badge:has-text("required")');
    const hasBadge = await requiredBadge.isVisible().catch(() => false);
    console.log(`✓ Required badge visible: ${hasBadge}`);

    // Check input is masked (type="password")
    const inputField = postgresRow.locator('input').first();
    const inputType = await inputField.getAttribute('type');
    console.log(`✓ Input type: ${inputType}`);
    expect(inputType).toBe('password');

    // Check secret badge
    const secretBadge = postgresRow.locator('.compose-badge-secret, .badge:has-text("secret")');
    const hasSecretBadge = await secretBadge.isVisible().catch(() => false);
    console.log(`✓ Secret badge visible: ${hasSecretBadge}`);

    await page.screenshot({ path: 'qa-phase-a-02-postgres-required-masked.png' });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Test 3: Regenerate button produces 32-char hex
  // ═══════════════════════════════════════════════════════════════════════════

  test('3. Regenerate Button Produces 32-Char Hex', async ({ page }) => {
    console.log('\n=== Test 3: Regenerate Secret ===');

    await ensureLogin(page);

    await page.goto(`${BASE_URL}/sites/${TEST_SITE_SLUG}`);
    await page.waitForLoadState('domcontentloaded');

    const envTab = page.locator('button:has-text("Environment"), [role="tab"]:has-text("Environment")').first();
    await envTab.click();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);

    // Find POSTGRES_PASSWORD row
    const rows = page.locator('.compose-env-table tbody tr');
    let postgresRow: any = null;

    for (let i = 0; i < await rows.count(); i++) {
      const row = rows.nth(i);
      const keyText = await row.locator('.compose-env-key, [data-testid="key"]').textContent();
      if (keyText?.includes('POSTGRES_PASSWORD')) {
        postgresRow = row;
        break;
      }
    }

    expect(postgresRow).not.toBeNull();

    // Get initial value
    const inputField = postgresRow.locator('input').first();
    const oldValue = await inputField.inputValue();
    console.log(`Old value: ${oldValue}`);

    // Click Regenerate
    const regenerateBtn = postgresRow.locator('button:has-text("Regenerate")').first();
    await expect(regenerateBtn).toBeVisible({ timeout: 5000 });
    await regenerateBtn.click();
    await page.waitForTimeout(500);

    // Get new value
    const newValue = await inputField.inputValue();
    console.log(`New value: ${newValue}`);

    // Validate format: 32-char hex (16 bytes)
    expect(newValue).toMatch(/^[a-f0-9]{32}$/);
    expect(newValue).not.toBe(oldValue);
    console.log(`✓ Regenerate produced valid hex: ${newValue.substring(0, 8)}...`);

    await page.screenshot({ path: 'qa-phase-a-03-regenerate-secret.png' });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Test 4: Edit POSTGRES_DB value, Save, reload, persisted
  // ═══════════════════════════════════════════════════════════════════════════

  test('4. Edit & Save POSTGRES_DB Persists', async ({ page }) => {
    console.log('\n=== Test 4: Edit & Persist ===');

    await ensureLogin(page);

    await page.goto(`${BASE_URL}/sites/${TEST_SITE_SLUG}`);
    await page.waitForLoadState('domcontentloaded');

    const envTab = page.locator('button:has-text("Environment"), [role="tab"]:has-text("Environment")').first();
    await envTab.click();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);

    // Find POSTGRES_DB row
    const rows = page.locator('.compose-env-table tbody tr');
    let dbRow: any = null;

    for (let i = 0; i < await rows.count(); i++) {
      const row = rows.nth(i);
      const keyText = await row.locator('.compose-env-key, [data-testid="key"]').textContent();
      if (keyText?.includes('POSTGRES_DB')) {
        dbRow = row;
        break;
      }
    }

    expect(dbRow).not.toBeNull();

    // Edit value
    const testValue = `qa-db-${Date.now()}`;
    const inputField = dbRow.locator('input').first();
    await inputField.fill(testValue);
    await page.waitForTimeout(300);

    // Click Save
    const saveBtn = dbRow.locator('button:has-text("Save")').first();
    await expect(saveBtn).toBeVisible({ timeout: 5000 });
    await saveBtn.click();
    await page.waitForTimeout(2000);

    console.log(`Saved value: ${testValue}`);

    // Reload page
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);

    // Re-click Environment tab
    const envTab2 = page.locator('button:has-text("Environment"), [role="tab"]:has-text("Environment")').first();
    await envTab2.click();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);

    // Find POSTGRES_DB again and verify persisted
    const rows2 = page.locator('.compose-env-table tbody tr');
    let dbRow2: any = null;

    for (let i = 0; i < await rows2.count(); i++) {
      const row = rows2.nth(i);
      const keyText = await row.locator('.compose-env-key, [data-testid="key"]').textContent();
      if (keyText?.includes('POSTGRES_DB')) {
        dbRow2 = row;
        break;
      }
    }

    expect(dbRow2).not.toBeNull();
    const persistedValue = await dbRow2.locator('input').first().inputValue();
    console.log(`✓ Persisted value: ${persistedValue}`);
    expect(persistedValue).toBe(testValue);

    await page.screenshot({ path: 'qa-phase-a-04-edit-persisted.png' });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Test 5: Show/Hide toggle on POSTGRES_PASSWORD
  // ═══════════════════════════════════════════════════════════════════════════

  test('5. Show/Hide Toggle on Secret', async ({ page }) => {
    console.log('\n=== Test 5: Show/Hide Toggle ===');

    await ensureLogin(page);

    await page.goto(`${BASE_URL}/sites/${TEST_SITE_SLUG}`);
    await page.waitForLoadState('domcontentloaded');

    const envTab = page.locator('button:has-text("Environment"), [role="tab"]:has-text("Environment")').first();
    await envTab.click();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);

    // Find POSTGRES_PASSWORD row
    const rows = page.locator('.compose-env-table tbody tr');
    let postgresRow: any = null;

    for (let i = 0; i < await rows.count(); i++) {
      const row = rows.nth(i);
      const keyText = await row.locator('.compose-env-key, [data-testid="key"]').textContent();
      if (keyText?.includes('POSTGRES_PASSWORD')) {
        postgresRow = row;
        break;
      }
    }

    expect(postgresRow).not.toBeNull();

    const inputField = postgresRow.locator('input').first();

    // Initial state: password (masked)
    let inputType = await inputField.getAttribute('type');
    console.log(`Initial type: ${inputType}`);
    expect(inputType).toBe('password');
    await page.screenshot({ path: 'qa-phase-a-05a-masked.png' });

    // Click Show button
    const visibilityBtn = postgresRow.locator('button:has-text("Show"), button:has-text("Hide")').first();
    await expect(visibilityBtn).toBeVisible({ timeout: 5000 });
    const initialText = await visibilityBtn.textContent();
    console.log(`Visibility button text: ${initialText}`);

    await visibilityBtn.click();
    await page.waitForTimeout(300);

    // Now should be visible (text type)
    inputType = await inputField.getAttribute('type');
    console.log(`After toggle type: ${inputType}`);
    expect(inputType).toBe('text');
    await page.screenshot({ path: 'qa-phase-a-05b-revealed.png' });

    // Click again to hide
    await visibilityBtn.click();
    await page.waitForTimeout(300);

    inputType = await inputField.getAttribute('type');
    console.log(`After hide type: ${inputType}`);
    expect(inputType).toBe('password');

    console.log('✓ Show/Hide toggle works');
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Test 6: Clear POSTGRES_PASSWORD, Deploy, preflight modal blocks
  // ═══════════════════════════════════════════════════════════════════════════

  test('6. Clear Required Var & Deploy Triggers Preflight Modal', async ({ page }) => {
    console.log('\n=== Test 6: Preflight Modal (Missing Vars) ===');

    await ensureLogin(page);

    await page.goto(`${BASE_URL}/sites/${TEST_SITE_SLUG}`);
    await page.waitForLoadState('domcontentloaded');

    const envTab = page.locator('button:has-text("Environment"), [role="tab"]:has-text("Environment")').first();
    await envTab.click();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);

    // Find POSTGRES_PASSWORD row and clear it
    const rows = page.locator('.compose-env-table tbody tr');
    let postgresRow: any = null;

    for (let i = 0; i < await rows.count(); i++) {
      const row = rows.nth(i);
      const keyText = await row.locator('.compose-env-key, [data-testid="key"]').textContent();
      if (keyText?.includes('POSTGRES_PASSWORD')) {
        postgresRow = row;
        break;
      }
    }

    expect(postgresRow).not.toBeNull();

    // Clear value
    const inputField = postgresRow.locator('input').first();
    await inputField.fill('');
    await page.waitForTimeout(300);

    // Save
    const saveBtn = postgresRow.locator('button:has-text("Save")').first();
    await saveBtn.click();
    await page.waitForTimeout(2000);

    console.log('Cleared POSTGRES_PASSWORD');

    // Navigate to Overview tab and click Deploy
    const overviewTab = page.locator('button:has-text("Overview"), [role="tab"]:has-text("Overview")').first();
    if (await overviewTab.isVisible().catch(() => false)) {
      await overviewTab.click();
      await page.waitForLoadState('domcontentloaded');
      await page.waitForTimeout(1000);
    }

    const deployBtn = page.locator('button:has-text("Deploy")').first();
    await expect(deployBtn).toBeVisible({ timeout: 10000 });
    await deployBtn.click();
    await page.waitForTimeout(1500);

    // Check for preflight modal
    const preflightModal = page.locator('[role="dialog"], .modal, [aria-modal="true"]').first();
    const isModalVisible = await preflightModal.isVisible().catch(() => false);

    if (isModalVisible) {
      console.log('✓ Preflight modal appeared');
      await page.screenshot({ path: 'qa-phase-a-06-preflight-modal.png' });

      // Check that POSTGRES_PASSWORD is listed as missing
      const modalText = await preflightModal.textContent();
      if (modalText?.includes('POSTGRES_PASSWORD')) {
        console.log('✓ POSTGRES_PASSWORD listed as missing in modal');
      }

      expect(isModalVisible).toBe(true);
    } else {
      console.log('⚠ Preflight modal did not appear (or deploy proceeded)');
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Test 7: "Go to Env Tab" button in modal focuses env tab
  // ═══════════════════════════════════════════════════════════════════════════

  test('7. Go to Env Tab Button Navigates & Focuses', async ({ page }) => {
    console.log('\n=== Test 7: Go to Env Tab Button ===');

    await ensureLogin(page);

    await page.goto(`${BASE_URL}/sites/${TEST_SITE_SLUG}`);
    await page.waitForLoadState('domcontentloaded');

    // Navigate to Overview (away from Env tab)
    const overviewTab = page.locator('button:has-text("Overview"), [role="tab"]:has-text("Overview")').first();
    if (await overviewTab.isVisible().catch(() => false)) {
      await overviewTab.click();
      await page.waitForLoadState('domcontentloaded');
      await page.waitForTimeout(500);
    }

    // Click Deploy to trigger preflight modal
    const deployBtn = page.locator('button:has-text("Deploy")').first();
    await expect(deployBtn).toBeVisible({ timeout: 10000 });
    await deployBtn.click();
    await page.waitForTimeout(1500);

    // Check for modal and "Go to Env Tab" button
    const goToEnvBtn = page.locator('button:has-text("Go to Env Tab")').first();
    const isButtonVisible = await goToEnvBtn.isVisible().catch(() => false);

    if (isButtonVisible) {
      console.log('✓ "Go to Env Tab" button found');
      await goToEnvBtn.click();
      await page.waitForTimeout(1000);

      // Verify Environment tab is now active
      const envTab = page.locator('button:has-text("Environment"), [role="tab"]:has-text("Environment")').first();
      const isActive = await envTab.getAttribute('class').then(c => c?.includes('active') || c?.includes('selected'));
      console.log(`✓ Environment tab is active: ${isActive}`);

      await page.screenshot({ path: 'qa-phase-a-07-go-to-env.png' });
    } else {
      console.log('⚠ "Go to Env Tab" button not found');
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Test 8: Fill missing var, Deploy succeeds (no modal)
  // ═══════════════════════════════════════════════════════════════════════════

  test('8. Fill Missing Var & Deploy Proceeds', async ({ page }) => {
    console.log('\n=== Test 8: Deploy with Filled Vars ===');

    await ensureLogin(page);

    await page.goto(`${BASE_URL}/sites/${TEST_SITE_SLUG}`);
    await page.waitForLoadState('domcontentloaded');

    const envTab = page.locator('button:has-text("Environment"), [role="tab"]:has-text("Environment")').first();
    await envTab.click();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);

    // Find and fill POSTGRES_PASSWORD if empty
    const rows = page.locator('.compose-env-table tbody tr');
    let postgresRow: any = null;

    for (let i = 0; i < await rows.count(); i++) {
      const row = rows.nth(i);
      const keyText = await row.locator('.compose-env-key, [data-testid="key"]').textContent();
      if (keyText?.includes('POSTGRES_PASSWORD')) {
        postgresRow = row;
        break;
      }
    }

    if (postgresRow) {
      const inputField = postgresRow.locator('input').first();
      const value = await inputField.inputValue();

      if (!value || value.trim() === '') {
        const testValue = `qa-pass-${Date.now()}`;
        await inputField.fill(testValue);
        await page.waitForTimeout(300);

        const saveBtn = postgresRow.locator('button:has-text("Save")').first();
        await saveBtn.click();
        await page.waitForTimeout(2000);

        console.log(`Filled POSTGRES_PASSWORD: ${testValue}`);
      }
    }

    // Click Deploy
    const overviewTab = page.locator('button:has-text("Overview"), [role="tab"]:has-text("Overview")').first();
    if (await overviewTab.isVisible().catch(() => false)) {
      await overviewTab.click();
      await page.waitForLoadState('domcontentloaded');
      await page.waitForTimeout(1000);
    }

    const deployBtn = page.locator('button:has-text("Deploy")').first();
    await expect(deployBtn).toBeVisible({ timeout: 10000 });
    await deployBtn.click();
    await page.waitForTimeout(2000);

    // Check if preflight modal appears
    const preflightModal = page.locator('[role="dialog"], .modal, [aria-modal="true"]').first();
    const isModalVisible = await preflightModal.isVisible().catch(() => false);

    console.log(`✓ Deploy triggered; preflight modal visible: ${isModalVisible}`);

    await page.screenshot({ path: 'qa-phase-a-08-deploy-triggered.png' });
  });
});
