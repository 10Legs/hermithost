import { test, expect } from '@playwright/test';

const BASE_URL = 'http://localhost:9080';

test.describe('GitHub Button Investigation', () => {
	test('should capture homepage and site details', async ({ page, context }) => {
		// Enable console logging
		page.on('console', (msg) => console.log(`[${msg.type().toUpperCase()}] ${msg.text()}`));
		page.on('pageerror', (error) => console.error(`[PAGE ERROR] ${error.message}`));

		// Test 1: Navigate to homepage
		console.log('\n=== TEST 1: Homepage ===');
		await page.goto(BASE_URL, { waitUntil: 'networkidle' });
		const homeScreenshot = await page.screenshot({ path: 'screenshots/01-homepage.png' });
		console.log('Homepage loaded and screenshotted');

		// Test 2: List sites on homepage
		const siteLinks = await page.locator('a[href^="/sites/"]').all();
		console.log(`Found ${siteLinks.length} site links on homepage`);

		if (siteLinks.length === 0) {
			console.warn('WARNING: No sites found on homepage. Cannot continue investigation.');
			return;
		}

		// Click first site
		const firstSiteHref = await siteLinks[0].getAttribute('href');
		console.log(`Clicking first site: ${firstSiteHref}`);
		await siteLinks[0].click();
		await page.waitForLoadState('networkidle');

		// Extract slug from URL
		const sitePath = page.url();
		const siteSlug = sitePath.split('/').pop();
		console.log(`Site URL: ${sitePath}`);
		console.log(`Site slug: ${siteSlug}`);

		// Test 3: Screenshot site overview
		console.log('\n=== TEST 2: Site Overview ===');
		await page.screenshot({ path: 'screenshots/02-site-overview.png' });
		console.log('Site overview screenshotted');

		// Get site metadata from page
		const siteTitle = await page.locator('h1.page-title').textContent();
		const siteMetaText = await page.locator('.site-meta').textContent();
		console.log(`Site title: ${siteTitle}`);
		console.log(`Site meta: ${siteMetaText}`);

		// Test 4: Navigate to Settings tab
		console.log('\n=== TEST 3: Settings Tab ===');
		await page.click('button.tab:has-text("Settings")');
		await page.waitForLoadState('networkidle');
		await page.screenshot({ path: 'screenshots/03-settings-tab.png' });
		console.log('Settings tab screenshotted');

		// Test 5: Check Deploy Authentication section
		console.log('\n=== TEST 4: Deploy Auth Section ===');
		const deployAuthSelect = await page.locator('#cfg-deploy-auth');
		const deployAuthValue = await deployAuthSelect.inputValue();
		console.log(`Deploy auth method: ${deployAuthValue}`);

		const deployKeySection = await page.locator('label:has-text("Deploy Key")');
		const isDeployKeyVisible = await deployKeySection.isVisible();
		console.log(`Deploy Key section visible: ${isDeployKeyVisible}`);

		// Test 6: Check for "Add to GitHub" button
		console.log('\n=== TEST 5: Add to GitHub Button ===');
		const addGithubBtn = await page.locator('button:has-text("Add to GitHub")');
		const isButtonVisible = await addGithubBtn.isVisible({ timeout: 2000 }).catch(() => false);
		console.log(`"Add to GitHub →" button visible: ${isButtonVisible}`);

		// Screenshot the Deploy Authentication section
		if (isDeployKeyVisible) {
			const deployKeyElement = await page.locator('label:has-text("Deploy Key")').locator('..').first();
			await deployKeyElement.screenshot({ path: 'screenshots/04-deploy-key-section.png' });
		}

		// Test 7: Check deploy key text visibility
		console.log('\n=== TEST 6: Deploy Key Text ===');
		const deployKeyText = await page.locator('.deploy-key-text');
		const isKeyTextVisible = await deployKeyText.isVisible({ timeout: 2000 }).catch(() => false);
		console.log(`Deploy key text visible: ${isKeyTextVisible}`);

		if (isKeyTextVisible) {
			const keyContent = await deployKeyText.textContent();
			console.log(`Deploy key preview (first 50 chars): ${keyContent?.substring(0, 50)}...`);
		} else {
			console.log('Deploy key text NOT visible (expected if key still loading)');
		}

		// Test 8: Call API to get site config
		console.log('\n=== TEST 7: API - Get Site Config ===');
		const siteConfigResponse = await page.request.get(`${BASE_URL}/api/sites/${siteSlug}`);
		if (siteConfigResponse.ok()) {
			const siteConfig = await siteConfigResponse.json();
			console.log(`Site deploy_auth: ${siteConfig.deploy_auth}`);
			console.log(`Site repository: ${siteConfig.repository || '(empty)'}`);
			console.log(`Full site config keys: ${Object.keys(siteConfig).join(', ')}`);
		} else {
			console.log(`ERROR: Failed to get site config (${siteConfigResponse.status()})`);
		}

		// Test 9: Call API to get deploy key
		console.log('\n=== TEST 8: API - Get Deploy Key ===');
		const deployKeyResponse = await page.request.get(`${BASE_URL}/api/config/deploy-key`);
		if (deployKeyResponse.ok()) {
			const keyData = await deployKeyResponse.json();
			console.log(`Deploy key response has public_key: ${!!keyData.public_key}`);
			if (keyData.public_key) {
				console.log(`Public key preview (first 50 chars): ${keyData.public_key.substring(0, 50)}...`);
			}
		} else {
			console.log(`ERROR: Failed to get deploy key (${deployKeyResponse.status()})`);
		}

		// Test 10: Check browser console for errors
		console.log('\n=== TEST 9: Browser Console Errors ===');
		const consoleErrors: string[] = [];
		page.on('console', (msg) => {
			if (msg.type() === 'error') {
				consoleErrors.push(msg.text());
			}
		});
		// Give page time to log any errors
		await page.waitForTimeout(1000);
		if (consoleErrors.length > 0) {
			console.log(`Found ${consoleErrors.length} console errors:`);
			consoleErrors.forEach((err) => console.log(`  - ${err}`));
		} else {
			console.log('No console errors detected');
		}

		// Test 11: Summary
		console.log('\n=== SUMMARY ===');
		console.log(`Deploy auth configured: ${deployAuthValue}`);
		console.log(`Deploy Key section visible: ${isDeployKeyVisible}`);
		console.log(`Deploy key text loaded: ${isKeyTextVisible}`);
		console.log(`"Add to GitHub →" button visible: ${isButtonVisible}`);
		console.log(`Expected button visibility: ${deployAuthValue === 'ssh_key' ? 'YES (auth is ssh_key)' : 'NO (auth is not ssh_key)'}`);
	});
});
