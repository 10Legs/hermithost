import type { Site } from './types';

export const SITES: Site[] = [
	{
		slug: 'portfolio-rdemeritt',
		name: 'portfolio.rdemeritt.com',
		domain: 'portfolio.rdemeritt.com',
		description: 'Personal portfolio and blog',
		repository: 'github.com/rdemeritt/portfolio',
		server: 'vps-01.rdemeritt.com',
		overallStatus: 'healthy',
		http: {
			reachable: true,
			statusCode: 200,
			responseTimeMs: 142,
			checkedAt: '2026-04-14T08:52:00Z'
		},
		ssl: {
			valid: true,
			expiresAt: '2026-07-10T00:00:00Z',
			daysUntilExpiry: 87,
			issuer: "Let's Encrypt",
			checkedAt: '2026-04-14T08:52:00Z'
		},
		dns: {
			resolving: true,
			propagated: true,
			checkedAt: '2026-04-14T08:52:00Z'
		},
		dnsRecords: [
			{ id: 'r1', type: 'A', name: '@', value: '167.99.142.78', ttl: 3600 },
			{ id: 'r2', type: 'A', name: 'www', value: '167.99.142.78', ttl: 3600 },
			{ id: 'r3', type: 'CNAME', name: 'mail', value: 'mail.protonmail.ch.', ttl: 3600 },
			{ id: 'r4', type: 'MX', name: '@', value: 'mail.protonmail.ch.', ttl: 3600, priority: 10 },
			{ id: 'r5', type: 'TXT', name: '@', value: 'v=spf1 include:_spf.protonmail.ch ~all', ttl: 3600 },
			{ id: 'r6', type: 'TXT', name: '_dmarc', value: 'v=DMARC1; p=quarantine; rua=mailto:dmarc@rdemeritt.com', ttl: 3600 }
		],
		deploys: [
			{
				id: 'd1',
				status: 'success',
				commitRef: 'a3f92c1',
				commitMessage: 'Update hero section copy and add new project case study',
				branch: 'main',
				triggeredBy: 'rdemeritt',
				startedAt: '2026-04-12T14:23:00Z',
				finishedAt: '2026-04-12T14:25:47Z',
				durationSeconds: 167,
				logLines: [
					'[14:23:00] Cloning repository github.com/rdemeritt/portfolio@a3f92c1',
					'[14:23:02] Clone complete. 342 files.',
					'[14:23:02] Installing dependencies (npm ci)...',
					'[14:23:18] ✓ 847 packages installed in 16.2s',
					'[14:23:18] Running build (npm run build)...',
					'[14:23:19] > portfolio@1.4.2 build',
					'[14:23:19] > vite build',
					'[14:23:19] vite v5.2.11 building for production...',
					'[14:23:24] ✓ 214 modules transformed.',
					'[14:23:26] dist/index.html                   2.41 kB',
					'[14:23:26] dist/assets/index-C2kB8Xr4.css    48.32 kB',
					'[14:23:26] dist/assets/index-BvT9R3mN.js    312.18 kB',
					'[14:23:26] ✓ built in 7.84s',
					'[14:23:26] Syncing to /var/www/portfolio.rdemeritt.com...',
					'[14:23:28] rsync complete. 31 files updated.',
					'[14:23:28] Running post-deploy hook: nginx -s reload',
					'[14:23:29] nginx: reloading configuration...',
					'[14:25:47] ✓ Deploy complete. Duration: 2m 47s',
					'[14:25:47] Site live at https://portfolio.rdemeritt.com'
				]
			},
			{
				id: 'd2',
				status: 'success',
				commitRef: '8e1d304',
				commitMessage: 'Fix mobile nav overflow on iOS Safari',
				branch: 'main',
				triggeredBy: 'rdemeritt',
				startedAt: '2026-04-09T10:05:00Z',
				finishedAt: '2026-04-09T10:07:22Z',
				durationSeconds: 142,
				logLines: [
					'[10:05:00] Cloning repository github.com/rdemeritt/portfolio@8e1d304',
					'[10:05:02] Clone complete.',
					'[10:05:02] Installing dependencies (npm ci)...',
					'[10:05:17] ✓ 847 packages installed in 15.1s',
					'[10:05:17] Running build (npm run build)...',
					'[10:05:24] ✓ built in 6.91s',
					'[10:05:24] Syncing to /var/www/portfolio.rdemeritt.com...',
					'[10:07:22] ✓ Deploy complete. Duration: 2m 22s'
				]
			}
		]
	},
	{
		slug: 'shallowfordroad',
		name: 'shallowfordroad.com',
		domain: 'shallowfordroad.com',
		description: 'Family property site',
		repository: 'github.com/rdemeritt/shallowfordroad',
		server: 'vps-01.rdemeritt.com',
		overallStatus: 'warning',
		http: {
			reachable: true,
			statusCode: 200,
			responseTimeMs: 98,
			checkedAt: '2026-04-14T08:52:00Z'
		},
		ssl: {
			valid: true,
			expiresAt: '2026-04-26T00:00:00Z',
			daysUntilExpiry: 12,
			issuer: "Let's Encrypt",
			checkedAt: '2026-04-14T08:52:00Z'
		},
		dns: {
			resolving: true,
			propagated: true,
			checkedAt: '2026-04-14T08:52:00Z'
		},
		dnsRecords: [
			{ id: 'r7', type: 'A', name: '@', value: '167.99.142.78', ttl: 3600 },
			{ id: 'r8', type: 'A', name: 'www', value: '167.99.142.78', ttl: 3600 },
			{ id: 'r9', type: 'TXT', name: '@', value: 'v=spf1 include:_spf.google.com ~all', ttl: 3600 },
			{ id: 'r10', type: 'MX', name: '@', value: 'aspmx.l.google.com.', ttl: 3600, priority: 1 }
		],
		deploys: [
			{
				id: 'd3',
				status: 'success',
				commitRef: 'c7a8f52',
				commitMessage: 'Update contact info and add photo gallery',
				branch: 'main',
				triggeredBy: 'rdemeritt',
				startedAt: '2026-04-01T09:15:00Z',
				finishedAt: '2026-04-01T09:17:33Z',
				durationSeconds: 153,
				logLines: [
					'[09:15:00] Cloning repository github.com/rdemeritt/shallowfordroad@c7a8f52',
					'[09:15:03] Clone complete. 198 files.',
					'[09:15:03] Installing dependencies (npm ci)...',
					'[09:15:19] ✓ 612 packages installed in 16.4s',
					'[09:15:19] Running build (npm run build)...',
					'[09:15:26] ✓ built in 6.23s',
					'[09:15:26] Syncing to /var/www/shallowfordroad.com...',
					'[09:17:33] ✓ Deploy complete. Duration: 2m 33s'
				]
			}
		]
	},
	{
		slug: 'client-staging',
		name: 'client-staging.example.com',
		domain: 'client-staging.example.com',
		description: 'Client project staging environment',
		repository: 'github.com/rdemeritt/client-project',
		server: 'vps-02.rdemeritt.com',
		overallStatus: 'error',
		http: {
			reachable: true,
			statusCode: 502,
			responseTimeMs: 3012,
			checkedAt: '2026-04-14T08:52:00Z'
		},
		ssl: {
			valid: true,
			expiresAt: '2026-07-01T00:00:00Z',
			daysUntilExpiry: 78,
			issuer: "Let's Encrypt",
			checkedAt: '2026-04-14T08:52:00Z'
		},
		dns: {
			resolving: true,
			propagated: true,
			checkedAt: '2026-04-14T08:52:00Z'
		},
		dnsRecords: [
			{ id: 'r11', type: 'A', name: '@', value: '68.183.91.44', ttl: 300 },
			{ id: 'r12', type: 'CNAME', name: 'www', value: 'client-staging.example.com.', ttl: 300 },
			{ id: 'r13', type: 'TXT', name: '@', value: 'v=spf1 include:mailgun.org ~all', ttl: 3600 }
		],
		deploys: [
			{
				id: 'd4',
				status: 'failed',
				commitRef: '2b9e711',
				commitMessage: 'Migrate database schema to v3 and update API endpoints',
				branch: 'main',
				triggeredBy: 'rdemeritt',
				startedAt: '2026-04-14T02:18:00Z',
				finishedAt: '2026-04-14T02:21:44Z',
				durationSeconds: 224,
				logLines: [
					'[02:18:00] Cloning repository github.com/rdemeritt/client-project@2b9e711',
					'[02:18:02] Clone complete. 891 files.',
					'[02:18:02] Installing dependencies (npm ci)...',
					'[02:18:21] ✓ 1243 packages installed in 19.1s',
					'[02:18:21] Running build (npm run build)...',
					'[02:18:29] ✓ built in 7.82s',
					'[02:18:29] Running pre-deploy checks...',
					'[02:18:30] Checking database connectivity...',
					'[02:18:30] ✓ Database reachable at db.internal:5432',
					'[02:18:30] Running migrations...',
					'[02:18:31] Migration 001_initial: already applied',
					'[02:18:31] Migration 002_add_users: already applied',
					'[02:18:31] Migration 003_schema_v3: running...',
					'[02:19:02] ERROR: column "legacy_id" of relation "orders" does not exist',
					'[02:19:02] DETAIL: Failed to execute: ALTER TABLE orders DROP COLUMN legacy_id;',
					'[02:19:02] Migration 003_schema_v3: FAILED',
					'[02:19:02] Rolling back transaction...',
					'[02:19:03] Rollback complete.',
					'[02:21:44] ✗ Deploy FAILED. Exit code 1.',
					'[02:21:44] Previous build is still live. No downtime occurred.',
					'[02:21:44] Fix required: column "legacy_id" does not exist in orders table. Check migration 003 assumptions.'
				]
			},
			{
				id: 'd5',
				status: 'success',
				commitRef: 'f4c3a29',
				commitMessage: 'Add pagination to orders API endpoint',
				branch: 'main',
				triggeredBy: 'rdemeritt',
				startedAt: '2026-04-13T11:44:00Z',
				finishedAt: '2026-04-13T11:46:18Z',
				durationSeconds: 138,
				logLines: [
					'[11:44:00] Cloning repository github.com/rdemeritt/client-project@f4c3a29',
					'[11:44:02] Clone complete.',
					'[11:44:02] Installing dependencies (npm ci)...',
					'[11:44:19] ✓ 1243 packages installed in 17.3s',
					'[11:44:19] Running build (npm run build)...',
					'[11:44:27] ✓ built in 7.64s',
					'[11:44:27] Running migrations (none pending)...',
					'[11:44:27] Syncing to /var/www/client-staging...',
					'[11:46:18] ✓ Deploy complete. Duration: 2m 18s'
				]
			}
		]
	},
	{
		slug: 'api-rdemeritt',
		name: 'api.rdemeritt.com',
		domain: 'api.rdemeritt.com',
		description: 'Personal API gateway and webhooks',
		repository: 'github.com/rdemeritt/api-gateway',
		server: 'vps-01.rdemeritt.com',
		overallStatus: 'healthy',
		http: {
			reachable: true,
			statusCode: 200,
			responseTimeMs: 67,
			checkedAt: '2026-04-14T08:52:00Z'
		},
		ssl: {
			valid: true,
			expiresAt: '2026-06-25T00:00:00Z',
			daysUntilExpiry: 71,
			issuer: "Let's Encrypt",
			checkedAt: '2026-04-14T08:52:00Z'
		},
		dns: {
			resolving: true,
			propagated: true,
			checkedAt: '2026-04-14T08:52:00Z'
		},
		dnsRecords: [
			{ id: 'r14', type: 'A', name: '@', value: '167.99.142.78', ttl: 3600 },
			{ id: 'r15', type: 'TXT', name: '@', value: 'v=spf1 -all', ttl: 3600 },
			{ id: 'r16', type: 'CAA', name: '@', value: '0 issue "letsencrypt.org"', ttl: 3600 }
		],
		deploys: [
			{
				id: 'd6',
				status: 'success',
				commitRef: '9d1b483',
				commitMessage: 'Add rate limiting middleware and update CORS headers',
				branch: 'main',
				triggeredBy: 'rdemeritt',
				startedAt: '2026-04-14T04:10:00Z',
				finishedAt: '2026-04-14T04:12:09Z',
				durationSeconds: 129,
				logLines: [
					'[04:10:00] Cloning repository github.com/rdemeritt/api-gateway@9d1b483',
					'[04:10:01] Clone complete. 127 files.',
					'[04:10:01] Installing dependencies (go mod download)...',
					'[04:10:09] ✓ Dependencies resolved.',
					'[04:10:09] Running build (go build ./...)...',
					'[04:10:14] ✓ Build complete. Binary: api-gateway (8.2 MB)',
					'[04:10:14] Running tests...',
					'[04:10:17] ok  github.com/rdemeritt/api-gateway/handlers  2.341s',
					'[04:10:18] ok  github.com/rdemeritt/api-gateway/middleware 1.892s',
					'[04:10:18] ✓ All tests passed.',
					'[04:10:18] Stopping existing service...',
					'[04:10:19] Copying binary to /usr/local/bin/api-gateway...',
					'[04:10:19] Starting service...',
					'[04:12:09] ✓ Deploy complete. Duration: 2m 9s'
				]
			}
		]
	},
	{
		slug: 'newsite-example',
		name: 'newsite.example.com',
		domain: 'newsite.example.com',
		description: 'New project — DNS propagating',
		repository: 'github.com/rdemeritt/newsite',
		server: 'vps-02.rdemeritt.com',
		overallStatus: 'pending',
		http: {
			reachable: false,
			statusCode: null,
			responseTimeMs: null,
			checkedAt: '2026-04-14T08:52:00Z'
		},
		ssl: {
			valid: false,
			expiresAt: null,
			daysUntilExpiry: null,
			issuer: null,
			checkedAt: '2026-04-14T08:52:00Z'
		},
		dns: {
			resolving: false,
			propagated: false,
			checkedAt: '2026-04-14T08:52:00Z'
		},
		dnsRecords: [
			{ id: 'r17', type: 'A', name: '@', value: '68.183.91.44', ttl: 300 },
			{ id: 'r18', type: 'A', name: 'www', value: '68.183.91.44', ttl: 300 }
		],
		deploys: [
			{
				id: 'd7',
				status: 'pending',
				commitRef: 'e0c2f19',
				commitMessage: 'Initial site scaffold',
				branch: 'main',
				triggeredBy: 'rdemeritt',
				startedAt: '2026-04-14T08:40:00Z',
				finishedAt: null,
				durationSeconds: null,
				logLines: [
					'[08:40:00] Cloning repository github.com/rdemeritt/newsite@e0c2f19',
					'[08:40:02] Clone complete. 24 files.',
					'[08:40:02] Installing dependencies (npm ci)...',
					'[08:40:11] ✓ 421 packages installed in 9.3s',
					'[08:40:11] Running build (npm run build)...',
					'[08:40:14] ✓ built in 3.12s',
					'[08:40:14] Syncing to /var/www/newsite.example.com...',
					'[08:40:16] ✓ Files deployed.',
					'[08:40:16] Waiting for DNS propagation before issuing SSL certificate...',
					'[08:40:16] DNS check: newsite.example.com → NOT RESOLVING (propagation in progress)',
					'[08:52:00] DNS check: newsite.example.com → NOT RESOLVING (propagation in progress)',
					'[08:52:00] Will retry in 5 minutes. SSL issuance pending.'
				]
			}
		]
	}
];

export function getSite(slug: string): Site | undefined {
	return SITES.find((s) => s.slug === slug);
}

export function formatRelativeTime(isoString: string): string {
	const date = new Date(isoString);
	const now = new Date('2026-04-14T09:00:00Z');
	const diffMs = now.getTime() - date.getTime();
	const diffMins = Math.floor(diffMs / 60000);
	const diffHours = Math.floor(diffMs / 3600000);
	const diffDays = Math.floor(diffMs / 86400000);

	if (diffMins < 1) return 'just now';
	if (diffMins < 60) return `${diffMins} minute${diffMins !== 1 ? 's' : ''} ago`;
	if (diffHours < 24) return `${diffHours} hour${diffHours !== 1 ? 's' : ''} ago`;
	return `${diffDays} day${diffDays !== 1 ? 's' : ''} ago`;
}

export function formatDuration(seconds: number): string {
	const m = Math.floor(seconds / 60);
	const s = seconds % 60;
	if (m === 0) return `${s}s`;
	return `${m}m ${s}s`;
}
