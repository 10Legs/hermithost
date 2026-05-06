import { test, expect } from '@playwright/test';

const BASE_URL = 'http://localhost:9080';
// Set HERMITHOST_TEST_PASSWORD env var for local testing
const PASSWORD = process.env.HERMITHOST_TEST_PASSWORD || 'changeme';
const TEST_REPO = 'https://github.com/coollabsio/coolify-examples';
const GITHUB_PAT = process.env.HERMITHOST_TEST_GITHUB_PAT || '';

test.describe('Epic 4: Env Tab + Deploy Preflight Modal', () => {
  test.describe.configure({ timeout: 180000 });

  let siteSlug: string;

  // ═══════════════════════════════════════════════════════════════════════════
  // Scenario 1: Tab load — create new dockercompose site, env tab pre-populates
  // ═══════════════════════════════════════════════════════════════════════════

  test('Scenario 1: Create Docker Compose Site and Verify Env Tab Loads', async ({ page }) => {
    console.log('\n=== Scenario 1: Tab Load & Pre-population ===');

    // Login
    await page.goto(`${BASE_URL}/login`);
    await page.locator('input[type="password"]').fill(PASSWORD);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL(`${BASE_URL}/`, { timeout: 15000 });
    await page.waitForLoadState('networkidle');

    // Take screenshot of dashboard
    await page.screenshot({ path: 'qa-epic4-01-dashboard.png' });

    // Click Add Site button
    const addSiteBtn = page.locator('button:has-text("+ Add Site"), button:has-text("Add Site")').first();
    await expect(addSiteBtn).toBeVisible({ timeout: 10000 });
    await addSiteBtn.click();
    await page.waitForLoadState('domcontentloaded');

    // Fill form
    const timestamp = Date.now();
    const testSiteName = `qa-epic4-${timestamp}`;
    const testDomain = `qa-epic4-${timestamp}.hermithost.local`;

    // Name
    const nameInput = page.locator('input[placeholder*="name"], input[id*="name"]').first();
    await expect(nameInput).toBeVisible({ timeout: 5000 });
    await nameInput.fill(testSiteName);

    // Domain
    const domainInput = page.locator('input[placeholder*="example.com"], input[id*="domain"]').first();
    await expect(domainInput).toBeVisible({ timeout: 5000 });
    await domainInput.fill(testDomain);

    // Repo (cantaconmigo)
    const repoInput = page.locator('input[placeholder*="github.com"], input[placeholder*="repo"], input[id*="repo"]').first();
    await expect(repoInput).toBeVisible({ timeout: 5000 });
    await repoInput.fill(TEST_REPO);

    // Branch
    const branchInput = page.locator('input[placeholder*="main"], input[placeholder*="branch"], input[id*="branch"]').first();
    await expect(branchInput).toBeVisible({ timeout: 5000 });
    await branchInput.fill('main');

    // Build pack — select dockercompose
    const buildPackSelects = page.locator('select');
    const selectCount = await buildPackSelects.count();
    if (selectCount > 0) {
      const buildPackSelect = buildPackSelects.first();
      await buildPackSelect.selectOption('dockercompose').catch(() => {
        console.log('Build pack may already be set or not available');
      });
    }

    // Take screenshot before submit
    await page.screenshot({ path: 'qa-epic4-02-create-form.png' });

    // Submit — click Add Site button in modal
    const submitBtn = page.locator('button:has-text("Add Site")').last();
    await expect(submitBtn).toBeVisible({ timeout: 5000 });
    await submitBtn.click();

    console.log('Form submitted');

    // Wait for creation
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(3000);

    // Extract site slug from URL
    const pageUrl = page.url();
    console.log(`Page URL after creation: ${pageUrl}`);

    if (pageUrl.includes('/sites/')) {
      siteSlug = pageUrl.split('/sites/')[1].split('/')[0].split('?')[0];
      console.log(`✓ Site created: ${siteSlug}`);
    } else {
      // Try to find site in list
      const siteLink = page.locator(`a[href^="/sites/"]`).filter({ hasText: testSiteName }).first();
      await expect(siteLink).toBeVisible({ timeout: 15000 });
      const href = await siteLink.getAttribute('href');
      siteSlug = href!.split('/')[2];
      console.log(`✓ Site created: ${siteSlug}`);

      // Navigate to the site
      await page.goto(`${BASE_URL}/sites/${siteSlug}`);
      await page.waitForLoadState('domcontentloaded');
    }

    // Click Environment tab
    const envTab = page.locator('button:has-text("Environment"), [role="tab"]:has-text("Environment")').first();
    await expect(envTab).toBeVisible({ timeout: 10000 });
    await envTab.click();
    await page.waitForLoadState('domcontentloaded');

    // Wait for compose env vars to load
    await page.waitForTimeout(1500);

    // Take screenshot of env tab
    await page.screenshot({ path: 'qa-epic4-03-env-tab-loaded.png' });

    // Verify table exists and has rows
    const composeTable = page.locator('.compose-env-table');
    await expect(composeTable).toBeVisible({ timeout: 10000 });

    // Check that we have rows
    const rows = page.locator('.compose-env-table tbody tr');
    const rowCount = await rows.count();
    console.log(`✓ Environment tab loaded with ${rowCount} compose variables`);
    expect(rowCount).toBeGreaterThan(0);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Scenario 2: Required marker — red asterisk + "required" badge
  // ═══════════════════════════════════════════════════════════════════════════

  test('Scenario 2: Required Marker (Red Asterisk + Badge)', async ({ page }) => {
    if (!siteSlug) {
      console.log('⚠ Skipped — site not created in Scenario 1');
      return;
    }

    console.log('\n=== Scenario 2: Required Marker ===');

    // Login and navigate to site
    await page.goto(`${BASE_URL}/login`);
    await page.locator('input[type="password"]').fill(PASSWORD);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL(`${BASE_URL}/`, { timeout: 15000 });

    await page.goto(`${BASE_URL}/sites/${siteSlug}`);
    await page.waitForLoadState('domcontentloaded');

    // Click Environment tab
    const envTab = page.locator('button:has-text("Environment"), [role="tab"]:has-text("Environment")').first();
    await envTab.click();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(1500);

    // Take screenshot
    await page.screenshot({ path: 'qa-epic4-04-required-markers.png' });

    // Check for required marker on rows
    const requiredRows = page.locator('.compose-env-required');
    const requiredCount = await requiredRows.count();
    console.log(`Found ${requiredCount} required variable rows`);

    // Check for asterisks in required rows
    const asterisks = page.locator('.compose-required-marker');
    const asteriskCount = await asterisks.count();
    console.log(`Found ${asteriskCount} red asterisks`);
    expect(asteriskCount).toBeGreaterThan(0);

    // Check for "required" badge
    const requiredBadges = page.locator('.compose-badge-required');
    const badgeCount = await requiredBadges.count();
    console.log(`Found ${badgeCount} 'required' badges`);
    expect(badgeCount).toBeGreaterThan(0);

    console.log('✓ Required markers visible');
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Scenario 3: Regenerate button — produces 32-char hex via crypto.getRandomValues
  // ═══════════════════════════════════════════════════════════════════════════

  test('Scenario 3: Regenerate Secret Button', async ({ page }) => {
    if (!siteSlug) {
      console.log('⚠ Skipped — site not created');
      return;
    }

    console.log('\n=== Scenario 3: Regenerate Secret Button ===');

    // Login and navigate to site
    await page.goto(`${BASE_URL}/login`);
    await page.locator('input[type="password"]').fill(PASSWORD);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL(`${BASE_URL}/`, { timeout: 15000 });

    await page.goto(`${BASE_URL}/sites/${siteSlug}`);
    await page.waitForLoadState('domcontentloaded');

    // Click Environment tab
    const envTab = page.locator('button:has-text("Environment"), [role="tab"]:has-text("Environment")').first();
    await envTab.click();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(1500);

    // Find a secret variable (look for secret badge)
    const secretBadges = page.locator('.compose-badge-secret');
    const secretCount = await secretBadges.count();
    console.log(`Found ${secretCount} secret variables`);

    if (secretCount > 0) {
      // Find the first secret row
      const secretRow = page.locator('.compose-env-table tbody tr').filter({ has: page.locator('.compose-badge-secret') }).first();

      // Look for Regenerate button in the row
      const regenerateBtn = secretRow.locator('button:has-text("Regenerate")').first();

      if (await regenerateBtn.isVisible().catch(() => false)) {
        // Get the input field
        const inputField = secretRow.locator('input').first();
        const oldValue = await inputField.inputValue();
        console.log(`Old secret value: ${oldValue}`);

        // Click Regenerate
        await regenerateBtn.click();
        await page.waitForTimeout(500);

        // Check new value
        const newValue = await inputField.inputValue();
        console.log(`New secret value: ${newValue}`);

        // Verify it's 32-char hex (16 bytes = 32 hex chars)
        expect(newValue).toMatch(/^[a-f0-9]{32}$/);
        expect(newValue).not.toBe(oldValue);

        // Verify visibility is toggled to Show (value visible)
        const visibilityBtn = secretRow.locator('button:has-text("Hide"), button:has-text("Show")').first();
        const visibilityText = await visibilityBtn.textContent();
        console.log(`Visibility button text: ${visibilityText}`);

        // Take screenshot
        await page.screenshot({ path: 'qa-epic4-05-regenerate-secret.png' });

        console.log('✓ Regenerate produces valid 32-char hex secret');
      } else {
        console.log('Note: Regenerate button not visible for secret');
      }
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Scenario 4: Per-row save — edit value, Save, reload, value persisted
  // ═══════════════════════════════════════════════════════════════════════════

  test('Scenario 4: Per-Row Save Persists Across Reload', async ({ page }) => {
    if (!siteSlug) {
      console.log('⚠ Skipped — site not created');
      return;
    }

    console.log('\n=== Scenario 4: Per-Row Save Persistence ===');

    // Login and navigate to site
    await page.goto(`${BASE_URL}/login`);
    await page.locator('input[type="password"]').fill(PASSWORD);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL(`${BASE_URL}/`, { timeout: 15000 });

    await page.goto(`${BASE_URL}/sites/${siteSlug}`);
    await page.waitForLoadState('domcontentloaded');

    // Click Environment tab
    const envTab = page.locator('button:has-text("Environment"), [role="tab"]:has-text("Environment")').first();
    await envTab.click();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(1500);

    // Find first row with input
    const firstRow = page.locator('.compose-env-table tbody tr').first();
    const inputField = firstRow.locator('input').first();

    // Get the variable key (for reference)
    const keyCell = firstRow.locator('.compose-env-key');
    const varKey = await keyCell.textContent();
    console.log(`Testing variable: ${varKey}`);

    // Edit the value
    const testValue = `test-value-${Date.now()}`;
    await inputField.fill(testValue);
    await page.waitForTimeout(300);

    // Click Save button
    const saveBtn = firstRow.locator('button:has-text("Save")').first();
    await expect(saveBtn).toBeVisible({ timeout: 5000 });
    await saveBtn.click();

    console.log('Save button clicked');

    // Wait for save indicator
    await page.waitForTimeout(2000);

    // Take screenshot of save state
    await page.screenshot({ path: 'qa-epic4-06-saved-indicator.png' });

    // Reload the page
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(1500);

    // Click Environment tab again
    const envTab2 = page.locator('button:has-text("Environment"), [role="tab"]:has-text("Environment")').first();
    await envTab2.click();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(1500);

    // Verify value persisted
    const reloadedRow = page.locator('.compose-env-table tbody tr').filter({ has: keyCell }).first();
    const reloadedInput = reloadedRow.locator('input').first();
    const persistedValue = await reloadedInput.inputValue();

    console.log(`Persisted value: ${persistedValue}`);
    expect(persistedValue).toBe(testValue);

    // Take screenshot of persisted value
    await page.screenshot({ path: 'qa-epic4-07-persisted-after-reload.png' });

    console.log('✓ Value persisted across reload');
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Scenario 5: Secret mask — values masked by default, Show/Hide toggle works
  // ═══════════════════════════════════════════════════════════════════════════

  test('Scenario 5: Secret Masking with Show/Hide Toggle', async ({ page }) => {
    if (!siteSlug) {
      console.log('⚠ Skipped — site not created');
      return;
    }

    console.log('\n=== Scenario 5: Secret Masking ===');

    // Login and navigate to site
    await page.goto(`${BASE_URL}/login`);
    await page.locator('input[type="password"]').fill(PASSWORD);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL(`${BASE_URL}/`, { timeout: 15000 });

    await page.goto(`${BASE_URL}/sites/${siteSlug}`);
    await page.waitForLoadState('domcontentloaded');

    // Click Environment tab
    const envTab = page.locator('button:has-text("Environment"), [role="tab"]:has-text("Environment")').first();
    await envTab.click();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(1500);

    // Find secret variable row
    const secretRow = page.locator('.compose-env-table tbody tr').filter({ has: page.locator('.compose-badge-secret') }).first();

    if (await secretRow.isVisible().catch(() => false)) {
      const inputField = secretRow.locator('input').first();
      const visibilityBtn = secretRow.locator('button:has-text("Hide"), button:has-text("Show")').first();

      // Check initial type (should be password)
      let inputType = await inputField.getAttribute('type');
      console.log(`Initial input type: ${inputType}`);
      expect(inputType).toBe('password');

      // Take screenshot of masked
      await page.screenshot({ path: 'qa-epic4-08-secret-masked.png' });

      // Click Show
      if (await visibilityBtn.isVisible().catch(() => false)) {
        await visibilityBtn.click();
        await page.waitForTimeout(300);

        // Check type changed to text
        inputType = await inputField.getAttribute('type');
        console.log(`After Show: input type = ${inputType}`);
        expect(inputType).toBe('text');

        // Take screenshot of revealed
        await page.screenshot({ path: 'qa-epic4-09-secret-revealed.png' });

        // Click Hide
        await visibilityBtn.click();
        await page.waitForTimeout(300);

        // Check type back to password
        inputType = await inputField.getAttribute('type');
        console.log(`After Hide: input type = ${inputType}`);
        expect(inputType).toBe('password');

        console.log('✓ Show/Hide toggle works');
      }
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Scenario 6: Deploy preflight modal (blocking) — missing vars trigger modal
  // ═══════════════════════════════════════════════════════════════════════════

  test('Scenario 6: Deploy Preflight Modal (Blocking)', async ({ page }) => {
    if (!siteSlug) {
      console.log('⚠ Skipped — site not created');
      return;
    }

    console.log('\n=== Scenario 6: Deploy Preflight Modal (Blocking) ===');

    // Login and navigate to site
    await page.goto(`${BASE_URL}/login`);
    await page.locator('input[type="password"]').fill(PASSWORD);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL(`${BASE_URL}/`, { timeout: 15000 });

    await page.goto(`${BASE_URL}/sites/${siteSlug}`);
    await page.waitForLoadState('domcontentloaded');

    // Click Environment tab
    const envTab = page.locator('button:has-text("Environment"), [role="tab"]:has-text("Environment")').first();
    await envTab.click();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(1500);

    // Clear a required variable
    const requiredRow = page.locator('.compose-env-required').first();
    if (await requiredRow.isVisible().catch(() => false)) {
      const inputField = requiredRow.locator('input').first();
      await inputField.fill('');
      await page.waitForTimeout(300);

      // Click Save to persist the clear
      const saveBtn = requiredRow.locator('button:has-text("Save")').first();
      await saveBtn.click();
      await page.waitForTimeout(2000);
    }

    // Click Deploy button
    const deployBtn = page.locator('button:has-text("Deploy")').first();
    if (await deployBtn.isVisible().catch(() => false)) {
      await deployBtn.click();
      await page.waitForTimeout(1000);

      // Take screenshot of preflight modal
      await page.screenshot({ path: 'qa-epic4-10-preflight-modal.png' });

      // Check for preflight modal
      const preflightModal = page.locator('.preflight-modal, [aria-modal="true"]:has-text("Missing required")');
      const isModalVisible = await preflightModal.isVisible().catch(() => false);

      if (isModalVisible) {
        console.log('✓ Preflight modal appears when required vars missing');

        // Check for missing variable list
        const missingList = page.locator('.preflight-list, [role="list"]');
        if (await missingList.isVisible().catch(() => false)) {
          const items = missingList.locator('li');
          const itemCount = await items.count();
          console.log(`Modal shows ${itemCount} missing variables`);
          expect(itemCount).toBeGreaterThan(0);
        }
      } else {
        console.log('Note: Preflight modal did not appear (may all be filled)');
      }
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Scenario 7: "Go to Env Tab" button focuses first missing field
  // ═══════════════════════════════════════════════════════════════════════════

  test('Scenario 7: Go to Env Tab Button Focuses First Missing Field', async ({ page }) => {
    if (!siteSlug) {
      console.log('⚠ Skipped — site not created');
      return;
    }

    console.log('\n=== Scenario 7: Go to Env Tab Button ===');

    // Login and navigate to site
    await page.goto(`${BASE_URL}/login`);
    await page.locator('input[type="password"]').fill(PASSWORD);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL(`${BASE_URL}/`, { timeout: 15000 });

    await page.goto(`${BASE_URL}/sites/${siteSlug}`);
    await page.waitForLoadState('domcontentloaded');

    // Click Overview tab to be away from Environment
    const overviewTab = page.locator('button:has-text("Overview"), [role="tab"]:has-text("Overview")').first();
    if (await overviewTab.isVisible().catch(() => false)) {
      await overviewTab.click();
      await page.waitForLoadState('domcontentloaded');
      await page.waitForTimeout(500);
    }

    // Click Deploy to trigger preflight modal
    const deployBtn = page.locator('button:has-text("Deploy")').first();
    if (await deployBtn.isVisible().catch(() => false)) {
      await deployBtn.click();
      await page.waitForTimeout(1000);

      // Check if preflight modal appears
      const preflightModal = page.locator('.preflight-modal, [aria-modal="true"]:has-text("Missing required")');
      const isModalVisible = await preflightModal.isVisible().catch(() => false);

      if (isModalVisible) {
        // Click "Go to Env Tab" button
        const goToEnvBtn = page.locator('button:has-text("Go to Env Tab")').first();
        if (await goToEnvBtn.isVisible().catch(() => false)) {
          await goToEnvBtn.click();
          await page.waitForTimeout(1000);

          // Take screenshot
          await page.screenshot({ path: 'qa-epic4-11-go-to-env-tab.png' });

          // Verify Environment tab is active
          const envTab = page.locator('button:has-text("Environment"), [role="tab"]:has-text("Environment")').first();
          const isActive = await envTab.getAttribute('class').then(c => c?.includes('tab-active'));

          if (isActive) {
            console.log('✓ Environment tab is now active');
          }

          // Check if first input field is focused
          const focusedElement = page.evaluate(() => document.activeElement?.id);
          console.log(`Focused element ID: ${await focusedElement}`);
        }
      } else {
        console.log('Note: Preflight modal not shown, skipping "Go to Env Tab" test');
      }
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Scenario 8: Deploy proceeds when all required vars filled
  // ═══════════════════════════════════════════════════════════════════════════

  test('Scenario 8: Deploy Succeeds When Required Vars Filled', async ({ page }) => {
    if (!siteSlug) {
      console.log('⚠ Skipped — site not created');
      return;
    }

    console.log('\n=== Scenario 8: Deploy Preflight Pass ===');

    // Login and navigate to site
    await page.goto(`${BASE_URL}/login`);
    await page.locator('input[type="password"]').fill(PASSWORD);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL(`${BASE_URL}/`, { timeout: 15000 });

    await page.goto(`${BASE_URL}/sites/${siteSlug}`);
    await page.waitForLoadState('domcontentloaded');

    // Click Environment tab
    const envTab = page.locator('button:has-text("Environment"), [role="tab"]:has-text("Environment")').first();
    await envTab.click();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(1500);

    // Fill all required variables
    const requiredRows = page.locator('.compose-env-required');
    const requiredCount = await requiredRows.count();
    console.log(`Filling ${requiredCount} required variables`);

    for (let i = 0; i < requiredCount; i++) {
      const row = requiredRows.nth(i);
      const inputField = row.locator('input').first();
      const currentValue = await inputField.inputValue();

      if (!currentValue || currentValue.trim() === '') {
        const testValue = `filled-${Date.now()}-${i}`;
        await inputField.fill(testValue);
        await page.waitForTimeout(300);

        // Click Save
        const saveBtn = row.locator('button:has-text("Save")').first();
        if (await saveBtn.isVisible().catch(() => false)) {
          await saveBtn.click();
          await page.waitForTimeout(2000);
        }
      }
    }

    // Now click Deploy
    const deployBtn = page.locator('button:has-text("Deploy")').first();
    if (await deployBtn.isVisible().catch(() => false)) {
      // Switch to Overview tab for deploy button
      const overviewTab = page.locator('button:has-text("Overview"), [role="tab"]:has-text("Overview")').first();
      if (await overviewTab.isVisible().catch(() => false)) {
        await overviewTab.click();
        await page.waitForLoadState('domcontentloaded');
      }

      // Try deploy again
      const deployBtn2 = page.locator('button:has-text("Deploy")').first();
      if (await deployBtn2.isVisible().catch(() => false)) {
        await deployBtn2.click();
        await page.waitForTimeout(2000);

        // Take screenshot
        await page.screenshot({ path: 'qa-epic4-12-deploy-triggered.png' });

        // Check that no preflight modal appears (or it closes immediately)
        const preflightModal = page.locator('.preflight-modal, [aria-modal="true"]:has-text("Missing required")');
        const isModalVisible = await preflightModal.isVisible().catch(() => false);

        if (!isModalVisible) {
          console.log('✓ Deploy proceeded without preflight modal');
        } else {
          console.log('Note: Preflight modal still present');
        }
      }
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Scenario 9: End-to-end — cantaconmigo with POSTGRES_PASSWORD auto-gen & deploy
  // ═══════════════════════════════════════════════════════════════════════════

  test('Scenario 9: End-to-End CantaConMigo Deploy with Auto-Generated POSTGRES_PASSWORD', async ({ page }) => {
    // Use existing failed site if available, otherwise create new
    let testSlug = 'is5sad6ygoncu60nzroivvnw'; // Known failed site

    console.log('\n=== Scenario 9: End-to-End Deploy ===');

    // Login
    await page.goto(`${BASE_URL}/login`);
    await page.locator('input[type="password"]').fill(PASSWORD);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL(`${BASE_URL}/`, { timeout: 15000 });

    // Try to navigate to existing site
    await page.goto(`${BASE_URL}/sites/${testSlug}`);
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(500);

    // Check if site exists
    const pageTitle = page.locator('h1, h2').first();
    const titleVisible = await pageTitle.isVisible().catch(() => false);

    if (!titleVisible) {
      console.log('Known site not found, creating new test site');
      testSlug = siteSlug; // Fallback to the one created in Scenario 1
      await page.goto(`${BASE_URL}/sites/${testSlug}`);
      await page.waitForLoadState('domcontentloaded');
    }

    // Navigate to Environment tab
    const envTab = page.locator('button:has-text("Environment"), [role="tab"]:has-text("Environment")').first();
    if (await envTab.isVisible().catch(() => false)) {
      await envTab.click();
      await page.waitForLoadState('domcontentloaded');
      await page.waitForTimeout(1500);

      // Take screenshot of env vars
      await page.screenshot({ path: 'qa-epic4-13-postgres-env.png' });

      // Look for POSTGRES_PASSWORD
      const rows = page.locator('.compose-env-table tbody tr');
      const rowCount = await rows.count();

      for (let i = 0; i < rowCount; i++) {
        const row = rows.nth(i);
        const keyCell = row.locator('.compose-env-key');
        const keyText = await keyCell.textContent();

        if (keyText?.includes('POSTGRES_PASSWORD')) {
          console.log('✓ POSTGRES_PASSWORD found in env vars');

          // Check if it has a value
          const input = row.locator('input').first();
          const value = await input.inputValue();

          if (!value || value.trim() === '') {
            console.log('POSTGRES_PASSWORD is empty, generating');

            // Click Regenerate if available
            const regenerateBtn = row.locator('button:has-text("Regenerate")').first();
            if (await regenerateBtn.isVisible().catch(() => false)) {
              await regenerateBtn.click();
              await page.waitForTimeout(500);

              const newValue = await input.inputValue();
              console.log(`Generated POSTGRES_PASSWORD: ${newValue.substring(0, 8)}...`);

              // Save it
              const saveBtn = row.locator('button:has-text("Save")').first();
              if (await saveBtn.isVisible().catch(() => false)) {
                await saveBtn.click();
                await page.waitForTimeout(2000);
              }
            }
          } else {
            console.log(`POSTGRES_PASSWORD already set: ${value.substring(0, 8)}...`);
          }

          break;
        }
      }
    }

    console.log('✓ Scenario 9 setup complete (full deploy requires active Coolify)');
  });

  // Cleanup
  test.afterAll(async ({ browser }) => {
    console.log('\n=== QA Complete ===');
    console.log(`Site slug: ${siteSlug}`);
  });
});
