<script lang="ts">
	import { onMount } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import { formatRelativeTime } from '$lib/data';
	import type { PageData } from './$types';
	import type { Site, SiteStatus } from '$lib/types';

	export let data: PageData;
	$: sites = data.sites;

	// ── Add Site Modal ─────────────────────────────────────────────────────────
	let showAddSite = false;
	let addName = '';
	let addDomain = '';
	let addGitRepo = '';
	let addGitBranch = 'main';
	let addBuildPack = 'nixpacks';
	let addDockerComposeLoc = '/docker-compose.yml';
	let addBaseDir = '/';
	let addDeployAuth: 'ssh_key' | 'pat' = 'ssh_key';
	let addDeployToken = '';
	type AddState = 'idle' | 'loading' | 'error';
	let addState: AddState = 'idle';
	let addError = '';
	let addNameError = '';
	let addDomainError = '';
	let addDeployTokenError = '';

	function openAddSite() {
		addName = '';
		addDomain = '';
		addGitRepo = '';
		addGitBranch = 'main';
		addBuildPack = 'nixpacks';
		addDockerComposeLoc = '/docker-compose.yml';
		addBaseDir = '/';
		addDeployAuth = 'ssh_key';
		addDeployToken = '';
		addState = 'idle';
		addError = '';
		addNameError = '';
		addDomainError = '';
		addDeployTokenError = '';
		showAddSite = true;
	}

	function closeAddSite() {
		if (addState === 'loading') return;
		showAddSite = false;
	}

	function handleAddKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') closeAddSite();
	}

	async function submitAddSite() {
		addNameError = '';
		addDomainError = '';
		addDeployTokenError = '';
		addError = '';
		let valid = true;
		if (!addName.trim()) { addNameError = 'Name is required'; valid = false; }
		if (!addDomain.trim()) { addDomainError = 'Domain is required'; valid = false; }
		if (addDeployAuth === 'pat' && !addDeployToken.trim()) {
			addDeployTokenError = 'Personal access token is required';
			valid = false;
		}
		if (!valid) return;

		addState = 'loading';
		try {
			const payload: Record<string, unknown> = {
				name: addName.trim(),
				domain: addDomain.trim(),
				git_repository: addGitRepo.trim(),
				git_branch: addGitBranch.trim() || 'main',
				build_pack: addBuildPack,
				deploy_auth: addDeployAuth,
				...(addBuildPack === 'dockercompose' ? { docker_compose_location: addDockerComposeLoc, base_directory: addBaseDir } : {}),
			};
			if (addDeployAuth === 'pat') {
				payload.deploy_token = addDeployToken.trim();
			}
			const res = await fetch('/api/sites', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(payload)
			});
			if (!res.ok) {
				const body: { error?: string } = await res.json().catch(() => ({}));
				addState = 'error';
				addError = body.error ?? `Failed to add site (${res.status})`;
				return;
			}
			showAddSite = false;
			await invalidateAll();
		} catch {
			addState = 'error';
			addError = 'Network error — could not reach server';
		}
	}

	// ── Sequential status probes ───────────────────────────────────────────────
	// Overlay map: slug → partial Site data fetched after mount
	let probeOverrides: Record<string, Partial<Pick<Site, 'http' | 'ssl' | 'dns' | 'overallStatus'>>> = {};
	let probePending: Set<string> = new Set();

	function effectiveSite(site: Site): Site {
		const over = probeOverrides[site.slug];
		if (!over) return site;
		return { ...site, ...over };
	}

	onMount(() => {
		const slugs = data.sites.map((s: Site) => s.slug);
		probePending = new Set(slugs);
		Promise.allSettled(
			slugs.map(slug =>
				Promise.race([
					fetch(`/api/sites/${slug}`).then(res => res.ok ? res.json() : null),
					new Promise<null>((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000))
				])
				.then((fresh: Site | null) => {
					if (fresh) {
						probeOverrides = {
							...probeOverrides,
							[slug]: { http: fresh.http, ssl: fresh.ssl, dns: fresh.dns, overallStatus: fresh.overallStatus }
						};
					}
				})
				.catch(() => { /* best-effort — leave existing status */ })
				.finally(() => {
					const next = new Set(probePending);
					next.delete(slug);
					probePending = next;
				})
			)
		);
	});

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

	// ── Pulse strips ───────────────────────────────────────────────────────────
	interface PulseBucket { ts: number; requests: number; }
	let pulseData: Record<string, { buckets: PulseBucket[]; max: number }> = {};

	async function loadPulse(slug: string): Promise<void> {
		try {
			const res = await fetch(`/api/sites/${slug}/stats/pulse`);
			if (res.ok) {
				const body: { buckets: PulseBucket[]; max_requests: number } = await res.json();
				pulseData = { ...pulseData, [slug]: { buckets: body.buckets, max: body.max_requests } };
			}
		} catch { /* silently skip */ }
	}

	onMount(() => {
		// Kick off pulse load for all sites (after status probes)
		setTimeout(() => {
			for (const s of data.sites) loadPulse(s.slug);
		}, 500);
	});

	function pulseColor(requests: number, max: number): string {
		if (max === 0 || requests === 0) return 'var(--bg-elevated)';
		const ratio = requests / max;
		if (ratio < 0.2) return 'rgba(76,175,130,0.25)';
		if (ratio < 0.5) return 'rgba(76,175,130,0.5)';
		if (ratio < 0.8) return 'rgba(76,175,130,0.75)';
		return 'rgba(76,175,130,1)';
	}
</script>

<svelte:window on:keydown={handleAddKeydown} />

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
			<button class="btn btn-primary" on:click={openAddSite}>+ Add Site</button>
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
					<th>Traffic (24h)</th>
					<th>Server</th>
					<th></th>
				</tr>
			</thead>
			<tbody>
				{#each sites as rawSite}
					{@const site = effectiveSite(rawSite)}
					{@const probing = probePending.has(rawSite.slug)}
					{@const pulse = pulseData[rawSite.slug]}
					<tr class="site-row" class:row-error={site.overallStatus === 'error'} class:row-warning={site.overallStatus === 'warning'}>
						<td class="cell-site">
							<div class="site-name-row">
								{#if probing}
									<span class="probe-spinner" title="Checking…" aria-label="Checking status"></span>
								{:else}
									<span class="status-dot status-{site.overallStatus}"></span>
								{/if}
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
						<td class="cell-pulse">
							{#if pulse && pulse.buckets.length > 0}
								<div class="pulse-strip" title="Request volume — last 24h">
									{#each pulse.buckets as bucket}
										<span
											class="pulse-col"
											style="background:{pulseColor(bucket.requests, pulse.max)}"
										></span>
									{/each}
								</div>
							{:else}
								<span class="text-muted mono" style="font-size:11px">—</span>
							{/if}
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

<!-- Add Site Modal -->
{#if showAddSite}
	<!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
	<!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
	<div class="modal-backdrop" role="presentation">
		<div class="modal-outside" on:click={closeAddSite} role="presentation"></div>
		<div class="modal" role="dialog" aria-modal="true" aria-labelledby="add-site-title">
			<div class="modal-header">
				<h2 class="modal-title" id="add-site-title">Add Site</h2>
				<button class="modal-close" on:click={closeAddSite} aria-label="Close">✕</button>
			</div>
			<div class="modal-body">
				{#if addError}
					<div class="form-error-banner">{addError}</div>
				{/if}
				<div class="form-field">
					<label for="add-name">Name <span class="required">*</span></label>
					<input
						id="add-name"
						bind:value={addName}
						class="input"
						class:input-error={addNameError}
						placeholder="My Site"
						disabled={addState === 'loading'}
					/>
					{#if addNameError}<span class="field-error">{addNameError}</span>{/if}
				</div>
				<div class="form-field">
					<label for="add-domain">Domain <span class="required">*</span></label>
					<input
						id="add-domain"
						bind:value={addDomain}
						class="input mono"
						class:input-error={addDomainError}
						placeholder="example.com"
						disabled={addState === 'loading'}
					/>
					{#if addDomainError}<span class="field-error">{addDomainError}</span>{/if}
				</div>
				<div class="form-field">
					<label for="add-git-repo">Git Repo URL</label>
					<input
						id="add-git-repo"
						bind:value={addGitRepo}
						class="input mono"
						placeholder="https://github.com/org/repo"
						disabled={addState === 'loading'}
					/>
				</div>
				<div class="form-field">
					<label for="add-git-branch">Git Branch</label>
					<input
						id="add-git-branch"
						bind:value={addGitBranch}
						class="input mono"
						placeholder="main"
						disabled={addState === 'loading'}
					/>
				</div>
				<div class="form-field">
					<label for="add-build-pack">Build Pack</label>
					<select
						id="add-build-pack"
						bind:value={addBuildPack}
						class="input"
						disabled={addState === 'loading'}
					>
						<option value="nixpacks">nixpacks</option>
						<option value="dockerfile">dockerfile</option>
						<option value="dockercompose">dockercompose</option>
						<option value="static">static</option>
					</select>
				</div>
				{#if addBuildPack === 'dockercompose'}
					<div class="form-field">
						<label for="add-compose-loc">Docker Compose File</label>
						<input
							id="add-compose-loc"
							bind:value={addDockerComposeLoc}
							class="input mono"
							placeholder="/docker-compose.yml"
							disabled={addState === 'loading'}
						/>
						<span class="field-hint">Path to compose file relative to repo root</span>
					</div>
					<div class="form-field">
						<label for="add-base-dir">Base Directory</label>
						<input
							id="add-base-dir"
							bind:value={addBaseDir}
							class="input mono"
							placeholder="/"
							disabled={addState === 'loading'}
						/>
						<span class="field-hint">Subdirectory for monorepos (usually /)</span>
					</div>
				{/if}
				<div class="form-field">
					<label>Deploy Auth</label>
					<div class="auth-toggle">
						<button
							type="button"
							class="auth-opt"
							class:auth-opt-active={addDeployAuth === 'ssh_key'}
							disabled={addState === 'loading'}
							on:click={() => { addDeployAuth = 'ssh_key'; addDeployTokenError = ''; }}
						>SSH Key</button>
						<button
							type="button"
							class="auth-opt"
							class:auth-opt-active={addDeployAuth === 'pat'}
							disabled={addState === 'loading'}
							on:click={() => { addDeployAuth = 'pat'; }}
						>Personal Token</button>
					</div>
					{#if addDeployAuth === 'ssh_key'}
						<span class="field-hint">Uses the server's deploy key — add it to your repo's deploy keys on GitHub.</span>
					{/if}
				</div>
				{#if addDeployAuth === 'pat'}
					<div class="form-field">
						<label for="add-deploy-token">GitHub Personal Access Token <span class="required">*</span></label>
						<input
							id="add-deploy-token"
							type="password"
							bind:value={addDeployToken}
							class="input mono"
							class:input-error={addDeployTokenError}
							placeholder="ghp_..."
							disabled={addState === 'loading'}
						/>
						{#if addDeployTokenError}<span class="field-error">{addDeployTokenError}</span>{/if}
						<span class="field-hint">Needs <code>repo</code> read scope. Embedded in clone URL — never logged.</span>
					</div>
				{/if}
			</div>
			<div class="modal-footer">
				<button class="btn btn-ghost" on:click={closeAddSite} disabled={addState === 'loading'}>Cancel</button>
				<button
					class="btn btn-primary"
					class:btn-loading={addState === 'loading'}
					disabled={addState === 'loading'}
					on:click={submitAddSite}
				>
					{addState === 'loading' ? 'Adding…' : 'Add Site'}
				</button>
			</div>
		</div>
	</div>
{/if}

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

	/* Probe spinner (replaces status-dot while probing) */
	.probe-spinner {
		display: inline-block;
		width: 8px;
		height: 8px;
		border: 1.5px solid var(--border-bright);
		border-top-color: var(--pending);
		border-radius: 50%;
		flex-shrink: 0;
		margin-top: 4px;
		animation: spin 0.7s linear infinite;
	}

	@keyframes spin {
		to { transform: rotate(360deg); }
	}

	/* Add Site Modal */
	.modal-backdrop {
		position: fixed;
		inset: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 100;
		padding: 24px;
		pointer-events: none;
	}

	.modal-outside {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.7);
		pointer-events: auto;
		cursor: default;
	}

	.modal {
		position: relative;
		z-index: 1;
		pointer-events: auto;
		background: var(--bg-surface);
		border: 1px solid var(--border-bright);
		border-radius: 10px;
		width: 100%;
		max-width: 480px;
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}

	.modal-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 16px 20px;
		border-bottom: 1px solid var(--border);
	}

	.modal-title {
		font-size: 15px;
		font-weight: 600;
		color: var(--text-primary);
	}

	.modal-close {
		background: none;
		border: none;
		color: var(--text-secondary);
		font-size: 14px;
		cursor: pointer;
		padding: 4px;
		line-height: 1;
		transition: color 0.1s;
	}

	.modal-close:hover {
		color: var(--text-primary);
	}

	.modal-body {
		padding: 20px;
		display: flex;
		flex-direction: column;
		gap: 14px;
	}

	.modal-footer {
		padding: 14px 20px;
		border-top: 1px solid var(--border);
		display: flex;
		justify-content: flex-end;
		gap: 8px;
	}

	.form-field {
		display: flex;
		flex-direction: column;
		gap: 5px;
	}

	label {
		font-size: 11px;
		font-weight: 500;
		text-transform: uppercase;
		letter-spacing: 0.07em;
		color: var(--text-secondary);
	}

	.required {
		color: var(--danger);
		text-transform: none;
		letter-spacing: 0;
	}

	.input {
		background: var(--bg-elevated);
		border: 1px solid var(--border-bright);
		border-radius: 5px;
		color: var(--text-primary);
		font-size: 13px;
		padding: 7px 10px;
		outline: none;
		transition: border-color 0.1s;
		width: 100%;
	}

	.input:focus {
		border-color: var(--accent-teal);
	}

	.input:disabled {
		opacity: 0.55;
		cursor: not-allowed;
	}

	.input-error {
		border-color: var(--danger);
	}

	.field-error {
		font-size: 11px;
		color: var(--danger);
	}

	.form-error-banner {
		background: rgba(207, 92, 92, 0.12);
		border: 1px solid rgba(207, 92, 92, 0.3);
		border-radius: 5px;
		padding: 8px 12px;
		font-size: 12px;
		color: var(--danger);
	}

	.btn-loading {
		opacity: 0.7;
		cursor: not-allowed;
	}

	.auth-toggle {
		display: flex;
		gap: 0;
		border: 1px solid var(--border-bright);
		border-radius: 5px;
		overflow: hidden;
	}

	.auth-opt {
		flex: 1;
		background: transparent;
		border: none;
		color: var(--text-secondary);
		font-size: 12px;
		font-weight: 500;
		padding: 6px 12px;
		cursor: pointer;
		transition: background 0.1s, color 0.1s;
	}

	.auth-opt:not(:last-child) {
		border-right: 1px solid var(--border-bright);
	}

	.auth-opt:hover:not(:disabled) {
		background: var(--bg-hover);
		color: var(--text-primary);
	}

	.auth-opt-active {
		background: var(--accent-teal);
		color: #fff;
	}

	.auth-opt-active:hover:not(:disabled) {
		background: var(--accent-teal-dim);
		color: #fff;
	}

	.auth-opt:disabled {
		opacity: 0.55;
		cursor: not-allowed;
	}

	.field-hint {
		font-size: 11px;
		color: var(--text-secondary);
		line-height: 1.4;
	}

	.field-hint code {
		font-family: var(--font-mono);
		background: var(--bg-elevated);
		padding: 1px 4px;
		border-radius: 3px;
	}

	/* Pulse strip */
	.cell-pulse {
		width: 120px;
		min-width: 100px;
	}

	.pulse-strip {
		display: flex;
		gap: 1px;
		align-items: flex-end;
		height: 20px;
		width: 100%;
	}

	.pulse-col {
		flex: 1;
		height: 100%;
		border-radius: 1px;
		min-width: 1px;
		transition: background 0.2s;
	}
</style>
