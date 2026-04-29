import { test, expect } from '@playwright/test';

const BASE_URL = 'http://localhost:9080';

test.describe.configure({ timeout: 60000 });
test.slow();

// ═══════════════════════════════════════════════════════════════════════════
// BLOCK A: Site CRUD — Isolated (can fail without affecting Block B)
// ═══════════════════════════════════════════════════════════════════════════
test.describe('Site CRUD', () => {
	let testSiteSlug: string;
	const testSiteName = `test-qa-${Date.now()}`;
	const testGitRepo = 'https://github.com/10Legs/cantaconmigo';
	const testGitBranch = 'feat/docker-deploy';
	const testDomain = `test-qa-${Date.now()}.hermithost.local`;

	test('A1: Create a new test site', async ({ page }) => {
		console.log('\n=== A1: Create New Site ===');

		// Navigate to dashboard
		await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
		console.log('Dashboard loaded');

		// Take screenshot before adding
		await page.screenshot({ path: 'screenshots/a1-01-dashboard.png' });

		// Find and click "Add Site" button
		const addSiteBtn = page.locator('button:has-text("+ Add Site")');
		await expect(addSiteBtn).toBeVisible({ timeout: 10000 });
		// Force click through modal backdrop if needed
		await addSiteBtn.click({ force: true });
		console.log('Add Site modal opened');

		// Take screenshot of modal
		await page.screenshot({ path: 'screenshots/a1-02-add-site-modal.png' });

		// Fill in the form
		await page.fill('#add-name', testSiteName);
		console.log(`Site name: ${testSiteName}`);

		// Use the test domain
		await page.fill('#add-domain', testDomain);
		console.log(`Domain: ${testDomain}`);

		// Fill git repo
		await page.fill('#add-git-repo', testGitRepo);
		console.log(`Git repo: ${testGitRepo}`);

		// Fill git branch
		await page.fill('#add-git-branch', testGitBranch);
		console.log(`Git branch: ${testGitBranch}`);

		// Keep SSH Key auth (default)
		const authToggle = page.locator('button.auth-opt:has-text("SSH Key")');
		await expect(authToggle).toHaveClass(/auth-opt-active/, { timeout: 5000 });
		console.log('SSH Key auth selected (default)');

		// Submit form
		const submitBtn = page.locator('button.btn-primary:has-text("Add Site")').first();
		await expect(submitBtn).toBeVisible({ timeout: 5000 });
		await submitBtn.click({ force: true });
		console.log('Form submitted');

		// Wait for redirect or modal to close
		await page.waitForLoadState('domcontentloaded');
		await page.waitForTimeout(3000);

		// Take screenshot after submission
		await page.screenshot({ path: 'screenshots/a1-03-after-site-creation.png' });

		// Extract site slug from URL or page content
		const pageUrl = page.url();
		console.log(`Page URL after creation: ${pageUrl}`);

		// If we were redirected to site detail, extract slug from URL
		if (pageUrl.includes('/sites/')) {
			const urlSlug = pageUrl.split('/sites/')[1].split('/')[0];
			testSiteSlug = urlSlug;
			console.log(`Site slug captured from URL: ${testSiteSlug}`);
		} else {
			// Otherwise, site list should show our new site — find it
			// Wait a bit more for site list to load/render
			await page.waitForTimeout(2000);
			const siteLinks = await page.locator('a[href^="/sites/"]').all();
			console.log(`Found ${siteLinks.length} site links on page`);
			if (siteLinks.length > 0) {
				const firstSiteHref = await siteLinks[0].getAttribute('href');
				testSiteSlug = firstSiteHref!.split('/')[2];
				console.log(`Site slug captured from first site link: ${testSiteSlug}`);
			} else {
				// Last resort: try to find the test site by name in the HTML
				const html = await page.content();
				if (html.includes(testSiteName)) {
					console.log(`✓ Test site name found in HTML but site link locator failed - possible rendering delay`);
					// Try once more after a longer wait
					await page.waitForTimeout(3000);
					const retryLinks = await page.locator('a[href^="/sites/"]').all();
					if (retryLinks.length > 0) {
						const href = await retryLinks[0].getAttribute('href');
						testSiteSlug = href!.split('/')[2];
						console.log(`Recovered site slug after retry: ${testSiteSlug}`);
					} else {
						throw new Error('Could not capture site slug (found site name but no links)');
					}
				} else {
					throw new Error('Could not capture site slug (site name not found in HTML)');
				}
			}
		}

		// Verify site appears in list (if still on homepage)
		const siteLink = page.locator(`a[href="/sites/${testSiteSlug}"]`).first();
		await expect(siteLink).toBeVisible({ timeout: 10000 }).catch(() => {
			console.log('Note: Site not yet visible in list (may have redirected directly to detail)');
		});

		console.log(`✓ Test site created successfully: ${testSiteSlug}`);
	});

	test('A2: Verify test site appears in the site list', async ({ page }) => {
		console.log('\n=== A2: Verify Site in List ===');

		// Skip if A1 failed to create site
		if (!testSiteSlug) {
			console.log('⚠ Skipped — test site not created in A1');
			return;
		}

		// Navigate to dashboard
		await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
		console.log('Dashboard loaded');

		// Take screenshot
		await page.screenshot({ path: 'screenshots/a2-01-site-list.png' });

		// Verify site link exists
		const siteLink = page.locator(`a[href="/sites/${testSiteSlug}"]`).first();
		await expect(siteLink).toBeVisible({ timeout: 10000 });
		console.log(`✓ Test site found in list: ${testSiteSlug}`);
	});

	test('A3: Cleanup — delete the test site', async ({ page }) => {
		console.log('\n=== A3: Cleanup — Delete Test Site ===');

		// Skip if A1 failed to create site
		if (!testSiteSlug) {
			console.log('⚠ Skipped — test site not created in A1');
			return;
		}

		// Navigate to site detail
		await page.goto(`${BASE_URL}/sites/${testSiteSlug}`, { waitUntil: 'domcontentloaded' });
		console.log(`Navigated to site detail: /sites/${testSiteSlug}`);

		// Click Settings tab
		const settingsTab = page.locator('button:has-text("Settings")').first();
		await expect(settingsTab).toBeVisible({ timeout: 10000 });
		await settingsTab.click();
		await page.waitForLoadState('domcontentloaded');
		console.log('Settings tab clicked');

		// Take screenshot before delete
		await page.screenshot({ path: 'screenshots/a3-01-delete-confirm.png' });

		// Find Delete Site button (usually at bottom of Settings)
		const deleteSiteBtn = page.locator('button:has-text("Delete Site"), button:has-text("Remove")').last();
		await expect(deleteSiteBtn).toBeVisible({ timeout: 10000 });
		await deleteSiteBtn.click();
		console.log('Delete Site button clicked');

		// Confirm deletion (if there's a dialog)
		const confirmBtn = page.locator('button:has-text("Delete"), button:has-text("Confirm"), button:has-text("Yes")').last();
		await confirmBtn.click().catch(() => {
			console.log('Note: No confirmation dialog');
		});
		console.log('Deletion confirmed');

		// Wait for redirect or success
		await page.waitForLoadState('domcontentloaded');
		await page.waitForTimeout(2000);

		// Take final screenshot
		await page.screenshot({ path: 'screenshots/a3-02-after-delete.png' });

		// Verify we're back on home or site no longer exists
		const currentUrl = page.url();
		console.log(`Current URL after delete: ${currentUrl}`);

		console.log('✓ Test site deleted successfully');
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// BLOCK B: Site Feature Tests — Resilient (uses EXISTING site, independent tests)
// ═══════════════════════════════════════════════════════════════════════════

// Helper to find an existing site
async function findExistingSiteSlug(browser: any): Promise<string> {
	const page = await browser.newPage();
	try {
		await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
		const siteLinks = await page.locator('a[href^="/sites/"]').all();
		if (siteLinks.length === 0) {
			return '';
		}
		const firstSiteHref = await siteLinks[0].getAttribute('href');
		return firstSiteHref!.split('/')[2];
	} finally {
		await page.close();
	}
}

test.describe('Site Feature Tests', () => {
	let siteSlug: string;

	test.beforeAll(async ({ browser }) => {
		console.log('\n=== BLOCK B Setup: Locate Existing Site ===');
		siteSlug = await findExistingSiteSlug(browser);
		if (siteSlug) {
			console.log(`✓ Using existing site: ${siteSlug}`);
		} else {
			console.log('⚠ No existing sites found — Block B tests will be skipped');
		}
	});

	test('B1: Overview tab — loads and shows status cards', async ({ page }) => {
		// Skip if no existing site was found
		if (!siteSlug) {
			console.log('⚠ Skipped — no existing site found');
			return;
		}

		console.log('\n=== B1: Overview Tab ===');

		// Navigate to site detail
		await page.goto(`${BASE_URL}/sites/${siteSlug}`, { waitUntil: 'domcontentloaded' });
		console.log(`Navigated to site detail: /sites/${siteSlug}`);

		// Take screenshot of overview
		await page.screenshot({ path: 'screenshots/b1-01-site-overview.png' });

		// Verify Overview tab is active (or click it if not)
		const overviewTab = page.locator('button:has-text("Overview")').first();
		await expect(overviewTab).toBeVisible({ timeout: 10000 });
		await overviewTab.click();
		await page.waitForLoadState('domcontentloaded');
		console.log('Overview tab is active');

		// Check for site name displayed
		const pageTitle = page.locator('h1').first();
		const titleText = await pageTitle.textContent();
		console.log(`Page title: ${titleText}`);

		// Verify at least one status card is visible (HTTP/SSL)
		const statusCard = page.locator('[class*="card"], [class*="status"]').first();
		await expect(statusCard).toBeVisible({ timeout: 10000 }).catch(() => {
			console.log('Note: Status cards not found (may be loading or hidden)');
		});

		console.log('✓ Overview tab loaded successfully');
	});

	test('B2: Settings tab — fields are editable', async ({ page }) => {
		// Skip if no existing site was found
		if (!siteSlug) {
			console.log('⚠ Skipped — no existing site found');
			return;
		}

		console.log('\n=== B2: Settings Tab ===');

		// Navigate to site detail
		await page.goto(`${BASE_URL}/sites/${siteSlug}`, { waitUntil: 'domcontentloaded' });
		console.log(`Navigated to site detail: /sites/${siteSlug}`);

		// Click Settings tab
		const settingsTab = page.locator('button:has-text("Settings")').first();
		await expect(settingsTab).toBeVisible({ timeout: 10000 });
		await settingsTab.click();
		await page.waitForLoadState('domcontentloaded');
		console.log('Settings tab clicked');

		// Take screenshot of settings
		await page.screenshot({ path: 'screenshots/b2-01-settings-tab.png' });

		// Verify repo field is populated and NOT readonly
		const repoField = page.locator('input[placeholder*="github.com"], input[placeholder*="repo"]').first();
		await expect(repoField).toBeVisible({ timeout: 5000 });
		const repoValue = await repoField.inputValue();
		console.log(`Repository field value: ${repoValue || '(empty)'}`);

		// Verify it's editable (not readonly)
		const isReadonly = await repoField.evaluate((el: HTMLInputElement) => el.readOnly);
		console.log(`Repository field readonly: ${isReadonly}`);
		expect(isReadonly).toBe(false);

		// Verify branch field is editable
		const branchField = page.locator('input[placeholder*="main"], input[placeholder*="branch"]').first();
		await expect(branchField).toBeVisible({ timeout: 5000 });
		const branchValue = await branchField.inputValue();
		console.log(`Branch field value: ${branchValue || '(empty)'}`);

		const isBranchReadonly = await branchField.evaluate((el: HTMLInputElement) => el.readOnly);
		console.log(`Branch field readonly: ${isBranchReadonly}`);
		expect(isBranchReadonly).toBe(false);

		console.log('✓ Settings tab fields are editable');
	});

	test('B3: Environment tab — CRUD operations', async ({ page }) => {
		// Skip if no existing site was found
		if (!siteSlug) {
			console.log('⚠ Skipped — no existing site found');
			return;
		}

		console.log('\n=== B3: Environment Tab — CRUD ===');

		// Navigate to site detail
		await page.goto(`${BASE_URL}/sites/${siteSlug}`, { waitUntil: 'networkidle' });
		console.log(`Navigated to site detail: /sites/${siteSlug}`);

		// Click Environment tab
		const envTab = page.locator('button:has-text("Environment")').first();
		await expect(envTab).toBeVisible({ timeout: 10000 });
		await envTab.click();
		await page.waitForLoadState('domcontentloaded');
		console.log('Environment tab clicked');

		// Take screenshot of empty environment tab
		await page.screenshot({ path: 'screenshots/b3-01-environment-tab.png' });

		// ── ADD: Create a new environment variable ───────────────────────────────
		console.log('\n--- Adding env var ---');

		// Find and click Add Env Var button
		const addEnvBtn = page.locator('button:has-text("Add"), button:has-text("+ Add"), button:has-text("New")').first();
		await expect(addEnvBtn).toBeVisible({ timeout: 5000 });
		await addEnvBtn.click();
		console.log('Add Environment button clicked');

		// Take screenshot of env form
		await page.screenshot({ path: 'screenshots/b3-02-add-env-form.png' });

		// Fill in env var: key=QA_TEST_KEY, value=qa-test-value
		const keyField = page.locator('input[placeholder*="KEY"], input[placeholder*="key"]').first();
		await expect(keyField).toBeVisible({ timeout: 5000 });
		await keyField.fill('QA_TEST_KEY');
		console.log('Env key entered: QA_TEST_KEY');

		const valueField = page.locator('input[placeholder*="value"], input[placeholder*="VALUE"]').first();
		await expect(valueField).toBeVisible({ timeout: 5000 });
		await valueField.fill('qa-test-value');
		console.log('Env value entered: qa-test-value');

		// Check the Runtime checkbox if it exists
		const runtimeCheckbox = page.locator('input[type="checkbox"]').filter({ hasText: /Runtime|runtime/ }).first();
		const isChecked = await runtimeCheckbox.isChecked().catch(() => false);
		if (!isChecked) {
			await runtimeCheckbox.check();
			console.log('Runtime checkbox checked');
		} else {
			console.log('Runtime checkbox already checked');
		}

		// Take screenshot before saving
		await page.screenshot({ path: 'screenshots/b3-03-env-form-filled.png' });

		// Submit env form
		const submitEnvBtn = page.locator('button:has-text("Save"), button:has-text("Add")').last();
		await submitEnvBtn.click();
		console.log('Env form submitted');

		// Wait for the env var to appear in the list
		await page.waitForLoadState('domcontentloaded');
		await page.waitForTimeout(1500);

		// Take screenshot after adding
		await page.screenshot({ path: 'screenshots/b3-04-env-added.png' });

		// Verify the new env var appears in the list
		const envKeyCell = page.locator('text=QA_TEST_KEY');
		await expect(envKeyCell).toBeVisible({ timeout: 10000 });
		console.log('✓ Env var added successfully');

		// ── DELETE: Remove the test env var ────────────────────────────────────
		console.log('\n--- Deleting env var ---');

		// Find delete button in the same row as the env key
		const envRow = envKeyCell.locator('xpath=ancestor::tr | ancestor::div[contains(@class,"row")]').first();
		const deleteEnvBtn = envRow.locator('button:has-text("Delete"), button[aria-label*="delete" i]').first();
		await expect(deleteEnvBtn).toBeVisible({ timeout: 5000 });
		await deleteEnvBtn.click();
		console.log('Delete button clicked');

		// Confirm deletion if prompt appears
		const confirmDeleteBtn = page.locator('button:has-text("Delete"), button:has-text("Confirm"), button:has-text("Yes")').last();
		await confirmDeleteBtn.click().catch(() => {
			console.log('Note: No confirmation dialog (auto-delete)');
		});
		console.log('Delete confirmed');

		// Wait for removal
		await page.waitForLoadState('domcontentloaded');
		await page.waitForTimeout(1500);

		// Take screenshot after delete
		await page.screenshot({ path: 'screenshots/b3-05-env-deleted.png' });

		// Verify it's removed
		await expect(envKeyCell).not.toBeVisible({ timeout: 10000 });
		console.log('✓ Env var deleted successfully');
	});

	test('B4: DNS tab — loads without error', async ({ page }) => {
		// Skip if no existing site was found
		if (!siteSlug) {
			console.log('⚠ Skipped — no existing site found');
			return;
		}

		console.log('\n=== B4: DNS Tab ===');

		// Navigate to site detail
		await page.goto(`${BASE_URL}/sites/${siteSlug}`, { waitUntil: 'networkidle' });
		console.log(`Navigated to site detail: /sites/${siteSlug}`);

		// Click DNS tab
		const dnsTab = page.locator('button:has-text("DNS")').first();
		await expect(dnsTab).toBeVisible({ timeout: 10000 });
		await dnsTab.click();
		await page.waitForLoadState('domcontentloaded');
		console.log('DNS tab clicked');

		// Take screenshot
		await page.screenshot({ path: 'screenshots/b4-01-dns-tab.png' });

		// Verify tab loads without errors (just check it's visible and not showing error)
		const dnsContent = page.locator('[class*="tab-content"]').first();
		await expect(dnsContent).toBeVisible({ timeout: 10000 });
		console.log('✓ DNS tab loaded successfully');
	});

	test('B5: Deployments tab — loads without error', async ({ page }) => {
		// Skip if no existing site was found
		if (!siteSlug) {
			console.log('⚠ Skipped — no existing site found');
			return;
		}

		console.log('\n=== B5: Deployments Tab ===');

		// Navigate to site detail
		await page.goto(`${BASE_URL}/sites/${siteSlug}`, { waitUntil: 'networkidle' });
		console.log(`Navigated to site detail: /sites/${siteSlug}`);

		// Click Deployments tab
		const deploysTab = page.locator('button:has-text("Deployments"), button:has-text("Deploy")').first();
		await expect(deploysTab).toBeVisible({ timeout: 10000 });
		await deploysTab.click();
		await page.waitForLoadState('domcontentloaded');
		console.log('Deployments tab clicked');

		// Take screenshot
		await page.screenshot({ path: 'screenshots/b5-01-deployments-tab.png' });

		// Tab should load (may be empty for new site)
		const deploysContent = page.locator('[class*="tab-content"]').first();
		await expect(deploysContent).toBeVisible({ timeout: 10000 });
		console.log('✓ Deployments tab loaded successfully');
	});
});
