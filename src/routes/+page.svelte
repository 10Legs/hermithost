<script lang="ts">
	import { formatRelativeTime } from '$lib/data';
	import type { PageData } from './$types';
	import type { Site } from '$lib/types';

	export let data: PageData;
	$: sites = data.sites;

	function getStatusLabel(site: Site): string {
		const labels: Record<string, string> = {
			healthy: 'Healthy',
			warning: 'Warning',
			error: 'Error',
			pending: 'Pending'
		};
		return labels[site.overallStatus] ?? site.overallStatus;
	}

	function sslLabel(site: Site): string {
		if (!site.ssl.valid) return 'No cert';
		const days = site.ssl.daysUntilExpiry;
		if (days === null) return 'Unknown';
		if (days <= 14) return `Expires in ${days}d`;
		return `Valid (${days}d)`;
	}

	function sslClass(site: Site): string {
		if (!site.ssl.valid) return 'text-danger';
		const days = site.ssl.daysUntilExpiry;
		if (days === null) return 'text-secondary';
		if (days <= 14) return 'text-warning';
		return 'text-success';
	}

	function httpLabel(site: Site): string {
		if (!site.http.reachable) return 'Unreachable';
		return `${site.http.statusCode} · ${site.http.responseTimeMs}ms`;
	}

	function httpClass(site: Site): string {
		if (!site.http.reachable) return 'text-danger';
		const code = site.http.statusCode ?? 0;
		if (code >= 500) return 'text-danger';
		if (code >= 400) return 'text-warning';
		return 'text-success';
	}

	function lastDeployLabel(site: Site): string {
		const latest = site.deploys?.[0];
		if (!latest) return 'Never deployed';
		return formatRelativeTime(latest.startedAt);
	}

	function lastDeployClass(site: Site): string {
		const latest = site.deploys?.[0];
		if (!latest) return 'text-muted';
		if (latest.status === 'failed') return 'text-danger';
		if (latest.status === 'running' || latest.status === 'pending') return 'text-pending';
		return 'text-secondary';
	}

	function lastDeployStatus(site: Site): string {
		const latest = site.deploys?.[0];
		if (!latest) return '';
		if (latest.status === 'failed') return ' · failed';
		if (latest.status === 'running') return ' · running';
		if (latest.status === 'pending') return ' · pending';
		return '';
	}

	$: healthySites = sites.filter(s => s.overallStatus === 'healthy').length;
	$: warningSites = sites.filter(s => s.overallStatus === 'warning').length;
	$: errorSites = sites.filter(s => s.overallStatus === 'error').length;
	$: pendingSites = sites.filter(s => s.overallStatus === 'pending').length;
</script>

<div class="page">
	<header class="page-header">
		<div>
			<h1 class="page-title">Sites</h1>
			<p class="page-sub">{sites.length} sites · last checked 7 minutes ago</p>
		</div>
		<div class="header-actions">
			<div class="stat-pills">
				{#if errorSites > 0}
					<span class="stat-pill pill-danger">{errorSites} error{errorSites !== 1 ? 's' : ''}</span>
				{/if}
				{#if warningSites > 0}
					<span class="stat-pill pill-warning">{warningSites} warning{warningSites !== 1 ? 's' : ''}</span>
				{/if}
				{#if pendingSites > 0}
					<span class="stat-pill pill-pending">{pendingSites} pending</span>
				{/if}
				<span class="stat-pill pill-success">{healthySites} healthy</span>
			</div>
			<button class="btn btn-primary">+ Add Site</button>
		</div>
	</header>

	<div class="table-wrapper">
		<table class="sites-table">
			<thead>
				<tr>
					<th>Site</th>
					<th>HTTP</th>
					<th>SSL</th>
					<th>DNS</th>
					<th>Last Deploy</th>
					<th>Server</th>
					<th></th>
				</tr>
			</thead>
			<tbody>
				{#each sites as site}
					<tr class="site-row" class:row-error={site.overallStatus === 'error'} class:row-warning={site.overallStatus === 'warning'}>
						<td class="cell-site">
							<div class="site-name-row">
								<span class="status-dot status-{site.overallStatus}"></span>
								<div>
									<a href="/sites/{site.slug}" class="site-domain">{site.domain}</a>
									<div class="site-desc">{site.description}</div>
								</div>
							</div>
						</td>
						<td>
							<span class="mono {httpClass(site)}">{httpLabel(site)}</span>
						</td>
						<td>
							<span class="mono {sslClass(site)}">{sslLabel(site)}</span>
						</td>
						<td>
							{#if site.dns.resolving && site.dns.propagated}
								<span class="text-success mono">Resolving</span>
							{:else if !site.dns.propagated}
								<span class="text-pending mono">Propagating…</span>
							{:else}
								<span class="text-danger mono">Not resolving</span>
							{/if}
						</td>
						<td>
							<span class="{lastDeployClass(site)} mono">{lastDeployLabel(site)}{lastDeployStatus(site)}</span>
						</td>
						<td>
							<span class="mono text-secondary">{site.server}</span>
						</td>
						<td class="cell-actions">
							<a href="/sites/{site.slug}" class="btn btn-ghost btn-sm">View →</a>
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
</div>

<style>
	.page {
		padding: 32px 40px;
		max-width: 1400px;
	}

	.page-header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		margin-bottom: 28px;
		gap: 16px;
	}

	.page-title {
		font-size: 22px;
		font-weight: 600;
		color: var(--text-primary);
		margin-bottom: 4px;
	}

	.page-sub {
		font-size: 12px;
		color: var(--text-secondary);
		font-family: var(--font-mono);
	}

	.header-actions {
		display: flex;
		align-items: center;
		gap: 12px;
		flex-shrink: 0;
	}

	.stat-pills {
		display: flex;
		gap: 6px;
	}

	.stat-pill {
		font-size: 11px;
		font-weight: 500;
		padding: 3px 8px;
		border-radius: 4px;
		border: 1px solid transparent;
	}

	.pill-danger {
		background: rgba(207, 92, 92, 0.15);
		color: var(--danger);
		border-color: rgba(207, 92, 92, 0.3);
	}

	.pill-warning {
		background: rgba(212, 168, 67, 0.15);
		color: var(--warning);
		border-color: rgba(212, 168, 67, 0.3);
	}

	.pill-pending {
		background: rgba(139, 157, 195, 0.15);
		color: var(--pending);
		border-color: rgba(139, 157, 195, 0.3);
	}

	.pill-success {
		background: rgba(76, 175, 130, 0.12);
		color: var(--success);
		border-color: rgba(76, 175, 130, 0.25);
	}

	.btn {
		border: none;
		border-radius: 5px;
		font-size: 13px;
		font-weight: 500;
		padding: 7px 14px;
		transition: background 0.1s, opacity 0.1s;
		display: inline-flex;
		align-items: center;
		gap: 6px;
		white-space: nowrap;
		color: var(--text-primary);
	}

	.btn-primary {
		background: var(--accent-teal);
		color: #fff;
	}

	.btn-primary:hover {
		background: var(--accent-teal-dim);
	}

	.btn-ghost {
		background: transparent;
		color: var(--text-secondary);
		border: 1px solid var(--border-bright);
	}

	.btn-ghost:hover {
		background: var(--bg-hover);
		color: var(--text-primary);
	}

	.btn-sm {
		font-size: 12px;
		padding: 5px 10px;
	}

	.table-wrapper {
		background: var(--bg-surface);
		border: 1px solid var(--border);
		border-radius: 8px;
		overflow: hidden;
	}

	.sites-table td {
		padding: 12px 12px;
	}

	.site-row {
		transition: background 0.1s;
	}

	.site-row:hover {
		background: var(--bg-hover);
	}

	.row-error {
		border-left: 2px solid var(--danger);
	}

	.row-warning {
		border-left: 2px solid var(--warning);
	}

	.cell-site {
		min-width: 260px;
	}

	.site-name-row {
		display: flex;
		align-items: flex-start;
		gap: 10px;
	}

	.status-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		flex-shrink: 0;
		margin-top: 4px;
	}

	.status-healthy { background: var(--success); }
	.status-warning { background: var(--warning); box-shadow: 0 0 6px rgba(212,168,67,0.4); }
	.status-error { background: var(--danger); box-shadow: 0 0 6px rgba(207,92,92,0.4); }
	.status-pending { background: var(--pending); animation: pulse 2s infinite; }

	@keyframes pulse {
		0%, 100% { opacity: 1; }
		50% { opacity: 0.4; }
	}

	.site-domain {
		font-family: var(--font-mono);
		font-size: 13px;
		color: var(--accent-teal);
		font-weight: 500;
		display: block;
		transition: color 0.1s;
	}

	.site-domain:hover {
		color: #5ab5b7;
	}

	.site-desc {
		font-size: 12px;
		color: var(--text-secondary);
		margin-top: 1px;
	}

	.cell-actions {
		text-align: right;
		width: 80px;
	}
</style>
