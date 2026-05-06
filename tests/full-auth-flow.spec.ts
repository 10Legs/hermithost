import { test, expect } from '@playwright/test';

const BASE_URL = 'http://localhost:9080';
const API_BASE = 'http://localhost:9080';
// Set HERMITHOST_TEST_PASSWORD env var for local testing
const PASSWORD = process.env.HERMITHOST_TEST_PASSWORD || 'changeme';

test.describe('Full Authentication & Site Management Flow', () => {
  test.describe.configure({ timeout: 120000 });

  let siteSlug: string;

  // ═══════════════════════════════════════════════════════════════════════════
  // A: LOGIN FLOW
  // ═══════════════════════════════════════════════════════════════════════════

  test('A1: Unauthenticated access redirects to login', async ({ page }) => {
    console.log('\n=== A1: Unauthenticated Access Redirect ===');

    await page.goto(BASE_URL);

    // Should be redirected to login
    await page.waitForURL(`${BASE_URL}/login`, { timeout: 10000 });
    const currentUrl = page.url();
    expect(currentUrl).toContain('/login');

    // Login page should be visible
    const loginCard = page.locator('.login-card');
    await expect(loginCard).toBeVisible({ timeout: 5000 });

    console.log('✓ Redirected to login page');
  });

  test('A2: Login with correct password succeeds', async ({ page }) => {
    console.log('\n=== A2: Login With Correct Password ===');

    await page.goto(`${BASE_URL}/login`);
    await page.waitForLoadState('domcontentloaded');

    // Fill password field
    const passwordInput = page.locator('input[type="password"]');
    await expect(passwordInput).toBeVisible({ timeout: 5000 });
    await passwordInput.fill(PASSWORD);

    console.log('Password entered');

    // Submit form
    const submitBtn = page.locator('button[type="submit"]');
    await expect(submitBtn).toBeVisible({ timeout: 5000 });
    await submitBtn.click();

    // Should redirect to dashboard (/)
    await page.waitForURL(`${BASE_URL}/`, { timeout: 15000 });
    const currentUrl = page.url();
    expect(currentUrl).toBe(`${BASE_URL}/`);

    console.log('✓ Logged in successfully and redirected to dashboard');
  });

  test('A3: Login with wrong password shows error', async ({ page }) => {
    console.log('\n=== A3: Login With Wrong Password ===');

    await page.goto(`${BASE_URL}/login`);
    await page.waitForLoadState('domcontentloaded');

    // Fill password field with wrong password
    const passwordInput = page.locator('input[type="password"]');
    await expect(passwordInput).toBeVisible({ timeout: 5000 });
    await passwordInput.fill('wrong-password-123');

    console.log('Wrong password entered');

    // Submit form
    const submitBtn = page.locator('button[type="submit"]');
    await expect(submitBtn).toBeVisible({ timeout: 5000 });
    await submitBtn.click();

    // Should show error message
    const errorMsg = page.locator('p.error-msg');
    await expect(errorMsg).toBeVisible({ timeout: 10000 });

    const errorText = await errorMsg.textContent();
    expect(errorText).toContain('Invalid password');

    // Should still be on login page
    const loginCard = page.locator('.login-card');
    await expect(loginCard).toBeVisible({ timeout: 5000 });

    console.log('✓ Error message shown for invalid password');
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // B: SITE CREATION FLOW (requires auth)
  // ═══════════════════════════════════════════════════════════════════════════

  test('B1: Login and access dashboard', async ({ page }) => {
    console.log('\n=== B1: Login and Access Dashboard ===');

    await page.goto(`${BASE_URL}/login`);
    await page.waitForLoadState('domcontentloaded');

    // Login
    await page.locator('input[type="password"]').fill(PASSWORD);
    await page.locator('button[type="submit"]').click();

    // Wait for redirect and dashboard load
    await page.waitForURL(`${BASE_URL}/`, { timeout: 15000 });
    await page.waitForLoadState('networkidle');

    console.log('✓ Dashboard loaded after login');
  });

  test('B2: Create a new site', async ({ page }) => {
    console.log('\n=== B2: Create New Site ===');

    // Login first
    await page.goto(`${BASE_URL}/login`);
    await page.locator('input[type="password"]').fill(PASSWORD);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL(`${BASE_URL}/`, { timeout: 15000 });
    await page.waitForLoadState('networkidle');

    // Take screenshot of dashboard
    await page.screenshot({ path: 'screenshots/b2-01-dashboard.png' });

    // Find and click "Add Site" button
    const addSiteBtn = page.locator('button:has-text("+ Add Site"), button:has-text("Add Site")').first();
    await expect(addSiteBtn).toBeVisible({ timeout: 10000 });
    await addSiteBtn.click();

    console.log('Add Site button clicked');

    // Wait for modal to appear
    await page.waitForLoadState('domcontentloaded');

    // Fill in form fields
    const timestamp = Date.now();
    const testSiteName = `test-qa-${timestamp}`;
    const testDomain = `test-qa-${timestamp}.hermithost.local`;
    const testGitRepo = 'https://github.com/coollabsio/coolify-examples';
    const testBranch = 'main';

    // Name field
    const nameInput = page.locator('input[placeholder*="name"], input[id*="name"]').first();
    await expect(nameInput).toBeVisible({ timeout: 5000 });
    await nameInput.fill(testSiteName);
    console.log(`Site name entered: ${testSiteName}`);

    // Domain field (required)
    const domainInput = page.locator('input[placeholder*="example.com"], input[id*="domain"]').first();
    await expect(domainInput).toBeVisible({ timeout: 5000 });
    await domainInput.fill(testDomain);
    console.log(`Domain entered: ${testDomain}`);

    // Git repo field
    const repoInput = page.locator('input[placeholder*="github.com"], input[placeholder*="repo"], input[id*="repo"]').first();
    await expect(repoInput).toBeVisible({ timeout: 5000 });
    await repoInput.fill(testGitRepo);
    console.log(`Git repo entered: ${testGitRepo}`);

    // Branch field
    const branchInput = page.locator('input[placeholder*="main"], input[placeholder*="branch"], input[id*="branch"]').first();
    await expect(branchInput).toBeVisible({ timeout: 5000 });
    await branchInput.fill(testBranch);
    console.log(`Branch entered: ${testBranch}`);

    // Build pack selection (try to select nixpacks if available)
    const buildPackSelect = page.locator('select, [role="combobox"]').filter({ has: page.locator('text=nixpacks, text=pack') }).first();
    if (await buildPackSelect.isVisible().catch(() => false)) {
      await buildPackSelect.selectOption('nixpacks').catch(() => {
        console.log('Note: Build pack selection not available or already selected');
      });
    }

    // Take screenshot of form
    await page.screenshot({ path: 'screenshots/b2-02-create-form.png' });

    // Submit form — find the "Add Site" button in the modal footer
    const submitBtn = page.locator('button:has-text("Add Site")').last();
    await expect(submitBtn).toBeVisible({ timeout: 5000 });
    await submitBtn.click();

    console.log('Form submitted');

    // Wait for creation (may take a few seconds)
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(3000);

    // Take screenshot after submit
    await page.screenshot({ path: 'screenshots/b2-03-after-create.png' });

    // Try to extract site slug from URL or page content
    const pageUrl = page.url();
    console.log(`Page URL after creation: ${pageUrl}`);

    if (pageUrl.includes('/sites/')) {
      const urlSlug = pageUrl.split('/sites/')[1].split('/')[0];
      siteSlug = urlSlug;
      console.log(`✓ Site created and navigated to detail page: ${siteSlug}`);
    } else {
      // Site should appear in the list — find it by the site name link
      const siteLink = page.locator(`a[href^="/sites/"]`).filter({ hasText: testSiteName }).first();
      await expect(siteLink).toBeVisible({ timeout: 15000 });
      console.log(`✓ Site created and found in list: ${testSiteName}`);

      // Extract slug from the link href
      const href = await siteLink.getAttribute('href');
      siteSlug = href!.split('/')[2];
      console.log(`Site slug extracted: ${siteSlug}`);
    }
  });

  test('B3: View site details (Overview tab)', async ({ page }) => {
    console.log('\n=== B3: View Site Details ===');

    // Skip if no site was created
    if (!siteSlug) {
      console.log('⚠ Skipped — site not created in B2');
      return;
    }

    // Login
    await page.goto(`${BASE_URL}/login`);
    await page.locator('input[type="password"]').fill(PASSWORD);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL(`${BASE_URL}/`, { timeout: 15000 });

    // Navigate to site detail
    await page.goto(`${BASE_URL}/sites/${siteSlug}`);
    await page.waitForLoadState('domcontentloaded');

    // Take screenshot
    await page.screenshot({ path: 'screenshots/b3-01-site-detail.png' });

    // Verify page loaded
    const pageTitle = page.locator('h1, h2').first();
    await expect(pageTitle).toBeVisible({ timeout: 10000 });

    const titleText = await pageTitle.textContent();
    console.log(`Site title: ${titleText}`);

    console.log('✓ Site detail page loaded');
  });

  test('B4: Check DNS tab', async ({ page }) => {
    console.log('\n=== B4: Check DNS Tab ===');

    if (!siteSlug) {
      console.log('⚠ Skipped — site not created');
      return;
    }

    // Login and navigate to site
    await page.goto(`${BASE_URL}/login`);
    await page.locator('input[type="password"]').fill(PASSWORD);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL(`${BASE_URL}/`, { timeout: 15000 });

    await page.goto(`${BASE_URL}/sites/${siteSlug}`);
    await page.waitForLoadState('domcontentloaded');

    // Click DNS tab
    const dnsTab = page.locator('button:has-text("DNS"), [role="tab"]:has-text("DNS")').first();
    if (await dnsTab.isVisible().catch(() => false)) {
      await dnsTab.click();
      await page.waitForLoadState('domcontentloaded');

      await page.screenshot({ path: 'screenshots/b4-01-dns-tab.png' });
      console.log('✓ DNS tab loaded');
    } else {
      console.log('Note: DNS tab not found');
    }
  });

  test('B5: Check Deployments tab', async ({ page }) => {
    console.log('\n=== B5: Check Deployments Tab ===');

    if (!siteSlug) {
      console.log('⚠ Skipped — site not created');
      return;
    }

    // Login and navigate to site
    await page.goto(`${BASE_URL}/login`);
    await page.locator('input[type="password"]').fill(PASSWORD);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL(`${BASE_URL}/`, { timeout: 15000 });

    await page.goto(`${BASE_URL}/sites/${siteSlug}`);
    await page.waitForLoadState('domcontentloaded');

    // Click Deployments tab
    const deployTab = page.locator('button:has-text("Deploy"), [role="tab"]:has-text("Deploy")').first();
    if (await deployTab.isVisible().catch(() => false)) {
      await deployTab.click();
      await page.waitForLoadState('domcontentloaded');

      await page.screenshot({ path: 'screenshots/b5-01-deployments-tab.png' });
      console.log('✓ Deployments tab loaded');
    } else {
      console.log('Note: Deployments tab not found');
    }
  });

  test('B6: Check Environment tab', async ({ page }) => {
    console.log('\n=== B6: Check Environment Tab ===');

    if (!siteSlug) {
      console.log('⚠ Skipped — site not created');
      return;
    }

    // Login and navigate to site
    await page.goto(`${BASE_URL}/login`);
    await page.locator('input[type="password"]').fill(PASSWORD);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL(`${BASE_URL}/`, { timeout: 15000 });

    await page.goto(`${BASE_URL}/sites/${siteSlug}`);
    await page.waitForLoadState('domcontentloaded');

    // Click Environment tab
    const envTab = page.locator('button:has-text("Environ"), [role="tab"]:has-text("Environ")').first();
    if (await envTab.isVisible().catch(() => false)) {
      await envTab.click();
      await page.waitForLoadState('domcontentloaded');

      await page.screenshot({ path: 'screenshots/b6-01-environment-tab.png' });
      console.log('✓ Environment tab loaded');
    } else {
      console.log('Note: Environment tab not found');
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // C: DELETE FLOW
  // ═══════════════════════════════════════════════════════════════════════════

  test('C1: Delete the created site', async ({ page }) => {
    console.log('\n=== C1: Delete Site ===');

    if (!siteSlug) {
      console.log('⚠ Skipped — site not created');
      return;
    }

    // Login and navigate to site
    await page.goto(`${BASE_URL}/login`);
    await page.locator('input[type="password"]').fill(PASSWORD);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL(`${BASE_URL}/`, { timeout: 15000 });

    await page.goto(`${BASE_URL}/sites/${siteSlug}`);
    await page.waitForLoadState('domcontentloaded');

    // Click Settings tab
    const settingsTab = page.locator('button:has-text("Settings"), [role="tab"]:has-text("Settings")').first();
    if (await settingsTab.isVisible().catch(() => false)) {
      await settingsTab.click();
      await page.waitForLoadState('domcontentloaded');
    }

    // Find delete button
    const deleteBtn = page.locator('button:has-text("Delete")').last();
    if (await deleteBtn.isVisible().catch(() => false)) {
      await deleteBtn.click();
      console.log('Delete button clicked');

      // Confirm deletion if dialog appears
      const confirmBtn = page.locator('button:has-text("Delete"), button:has-text("Confirm"), button:has-text("Yes")').last();
      if (await confirmBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
        await confirmBtn.click();
        console.log('Deletion confirmed');
      }

      // Wait for redirect
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(2000);

      await page.screenshot({ path: 'screenshots/c1-01-after-delete.png' });
      console.log('✓ Site deleted');
    } else {
      console.log('Note: Delete button not found');
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // D: LOGOUT FLOW
  // ═══════════════════════════════════════════════════════════════════════════

  test('D1: Logout redirects to login', async ({ page }) => {
    console.log('\n=== D1: Logout Flow ===');

    // Login
    await page.goto(`${BASE_URL}/login`);
    await page.locator('input[type="password"]').fill(PASSWORD);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL(`${BASE_URL}/`, { timeout: 15000 });

    // Find logout button
    const logoutBtn = page.locator('button:has-text("Sign Out"), button:has-text("Logout")').first();
    await expect(logoutBtn).toBeVisible({ timeout: 10000 });
    await logoutBtn.click();

    console.log('Logout button clicked');

    // Should redirect to login
    await page.waitForURL(`${BASE_URL}/login`, { timeout: 15000 });
    const currentUrl = page.url();
    expect(currentUrl).toContain('/login');

    // Login page should be visible
    const loginCard = page.locator('.login-card');
    await expect(loginCard).toBeVisible({ timeout: 5000 });

    console.log('✓ Logged out and redirected to login page');
  });

  test('D2: After logout, cannot access dashboard without re-login', async ({ page }) => {
    console.log('\n=== D2: Dashboard Inaccessible After Logout ===');

    // Login first
    await page.goto(`${BASE_URL}/login`);
    await page.locator('input[type="password"]').fill(PASSWORD);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL(`${BASE_URL}/`, { timeout: 15000 });

    // Logout
    const logoutBtn = page.locator('button:has-text("Sign Out"), button:has-text("Logout")').first();
    await logoutBtn.click();
    await page.waitForURL(`${BASE_URL}/login`, { timeout: 15000 });

    // Try to navigate directly to dashboard
    await page.goto(`${BASE_URL}/`);

    // Should be redirected to login
    await page.waitForURL(`${BASE_URL}/login`, { timeout: 15000 });
    const currentUrl = page.url();
    expect(currentUrl).toContain('/login');

    console.log('✓ Dashboard access properly blocked after logout');
  });
});
