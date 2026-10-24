// PR #142: repos stored as ssh://git@ssh.github.com:443/<owner>/<repo>.git (SSH over port
// 443) must still get the "Add to GitHub →" deploy-key button in Site → Settings.
import { site, siteStats, stubApi, stubGithub, authOk, DEMO_DEPLOY_KEY } from '../fixtures.mjs';
import { highlight } from '../lib.mjs';

const REPO = 'ssh://git@ssh.github.com:443/10Legs/demo-site.git';

export default {
	async setup(context) {
		await stubGithub(context);
		await stubApi(context, {
			...authOk,
			...siteStats('demo-site'),
			'GET /api/sites/demo-site': site({ repository: REPO, deploy_auth: 'ssh_key' }),
			'GET /api/config/deploy-key': { public_key: DEMO_DEPLOY_KEY },
		});
		// window.open → same tab, so the GitHub stand-in shows up in this single recording.
		await context.addInitScript(() => { window.open = (u) => { location.href = u; return null; }; });
	},

	async run(page, { caption, before }) {
		await page.goto('/sites/demo-site');
		await page.getByRole('button', { name: 'Settings' }).waitFor();
		await caption('Site "demo-site" (test data), deployed with an SSH deploy key');
		await page.getByRole('button', { name: 'Settings' }).click();
		const repo = page.locator('#cfg-repo');
		await highlight(repo);
		await caption(`Its repository uses the SSH-over-443 form: ${REPO}`, 3200);

		const keyBlock = page.locator('.deploy-key-block');
		await highlight(keyBlock);
		await caption('Deploy Authentication → Deploy Key: copy this key into the GitHub repo', 2600);

		const addBtn = page.getByRole('button', { name: /Add to GitHub/ });
		if (before) {
			await caption('BEFORE: no "Add to GitHub →" button for this repo URL, only "Copy Key"', 3600);
			return;
		}
		await highlight(addBtn);
		await caption('AFTER: "Add to GitHub →" is back for SSH-over-443 repo URLs', 3000);
		await caption('Clicking it opens GitHub\'s "add deploy key" page for 10Legs/demo-site', 1600);
		await addBtn.click();
		await page.waitForURL(/github\.com\/10Legs\/demo-site\/settings\/keys\/new/);
		await caption('Opened github.com/10Legs/demo-site/settings/keys/new (new tab in real use; stand-in page here)', 3200);
	},
};
