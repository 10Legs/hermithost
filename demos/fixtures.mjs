// Safe, made-up data for demo recordings. Never put real domains, keys, tokens or
// personal data here.
const now = new Date().toISOString();
const inDays = (d) => new Date(Date.now() + d * 86_400_000).toISOString();

export function site(overrides = {}) {
	return {
		slug: 'demo-site',
		name: 'demo-site',
		domain: 'demo-site.example.test',
		description: 'Demo site (test data)',
		repository: 'https://github.com/10Legs/demo-site',
		server: 'localhost',
		deploy_auth: 'ssh_key',
		branch: 'main',
		build_pack: 'nixpacks',
		docker_compose_location: '/docker-compose.yml',
		base_directory: '/',
		http: { reachable: true, statusCode: 200, responseTimeMs: 42, checkedAt: now },
		ssl: { valid: true, expiresAt: inDays(59), daysUntilExpiry: 59, issuer: 'Demo CA', checkedAt: now },
		dns: { resolving: true, propagated: true, checkedAt: now },
		overallStatus: 'healthy',
		disabled: false,
		include_source_commit: false,
		...overrides,
	};
}

export const DEMO_DEPLOY_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDEMOKEYxFORxRECORDINGSxONLYxNOTxREAL hermithost-demo';

/**
 * Stand in for the HermitHost API: every /api/* request is answered in the browser from
 * `routes` (exact "METHOD /path" or "/path" keys), else an empty 200.
 */
export async function stubApi(context, routes = {}) {
	await context.route('**/api/**', async (route) => {
		const req = route.request();
		const url = new URL(req.url());
		const key = `${req.method()} ${url.pathname}`;
		const body = routes[key] ?? routes[url.pathname];
		if (url.pathname.endsWith('/stats/live')) {
			await route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': demo\n\n' });
			return;
		}
		const value = typeof body === 'function' ? await body(req) : body;
		await route.fulfill({
			status: value?.__status ?? 200,
			contentType: 'application/json',
			body: JSON.stringify(value?.__status ? value.body ?? {} : value ?? (req.method() === 'GET' ? [] : {})),
		});
	});
}

/** Stand in for github.com so demos never depend on (or log into) the real site. */
export async function stubGithub(context) {
	await context.route('https://github.com/**', (route) => {
		const u = new URL(route.request().url());
		route.fulfill({
			status: 200,
			contentType: 'text/html',
			body: `<html><body style="font:18px system-ui;padding:48px;background:#0d1117;color:#e6edf3">
				<p style="opacity:.6">GitHub (stand-in for the recording)</p>
				<h1 style="font-size:28px">${u.pathname}</h1>
				<p>A real GitHub page would open here.</p></body></html>`,
		});
	});
}

export const authOk = { 'GET /api/auth/check': { authenticated: true } };

/** Stats endpoints for a site's Overview tab (made-up numbers). */
export function siteStats(slug = 'demo-site') {
	const t0 = Math.floor(Date.now() / 1000) - 24 * 3600;
	return {
		[`GET /api/sites/${slug}/stats`]: {
			range: '24h', requests: 1280, human_requests: 940, bot_requests: 340,
			bandwidth_bytes: 52_428_800, error_rate: 0.004, avg_ms: 38,
			sparkline: Array.from({ length: 24 }, (_, i) => ({ ts: t0 + i * 3600, requests: 30 + ((i * 7) % 40) })),
		},
		[`GET /api/sites/${slug}/stats/pages`]: {
			range: '24h',
			top_pages: [{ path: '/', requests: 620, human_requests: 480, avg_ms: 31, error_rate: 0, trend: 4 }],
			top_referrers: [{ referrer_domain: 'example.test', requests: 42 }],
		},
	};
}
