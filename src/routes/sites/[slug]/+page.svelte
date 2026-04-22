<script lang="ts">
	import { onMount } from 'svelte';
	import type { PageData } from './$types';
	import { formatRelativeTime, formatDuration } from '$lib/data';
	import type { DnsRecord, Deploy, Site } from '$lib/types';

	export let data: PageData;

	$: site = data.site;
	$: dns = data.dns;
	let deploys = data.deploys;

	let activeTab: 'overview' | 'dns' | 'deployments' | 'settings' = 'overview';

	// Deploy button state
	type DeployState = 'idle' | 'loading' | 'success' | 'error' | 'unavailable';
	let deployState: DeployState = 'idle';
	let deployMessage: string = '';

	// Refresh checks state
	let refreshState: 'idle' | 'loading' = 'idle';

	async function refreshChecks(): Promise<void> {
		refreshState = 'loading';
		try {
			const res = await fetch(`/api/sites/${site.slug}`);
			if (res.ok) {
				const fresh: Site = await res.json();
				data = { ...data, site: fresh };
			}
		} catch {
			// silently fail — status stays as-is
		} finally {
			refreshState = 'idle';
		}
	}

	// Settings form state
	let settingsDomain = data.site.domain;
	let settingsRepo = data.site.repository;
	let settingsServer = data.site.server;
	let settingsDesc = data.site.description;
	let settingsDeployAuth: 'ssh_key' | 'pat' = data.site.deploy_auth;
	let settingsDeployToken = '';
	type AuthSaveState = 'idle' | 'saving' | 'saved' | 'error';
	let authSaveState: AuthSaveState = 'idle';
	let authSaveMessage = '';

	$: {
		// Keep settings fields in sync when site changes (e.g. after refresh)
		settingsDomain = site.domain;
		settingsRepo = site.repository;
		settingsServer = site.server;
		settingsDesc = site.description;
		// Note: settingsDeployAuth is NOT synced here — bind:value conflicts with $: assignment.
		// It is updated explicitly in saveDeployAuth() after a successful response.
	}

	type SaveState = 'idle' | 'saving' | 'saved' | 'error';
	let saveState: SaveState = 'idle';
	let saveMessage = '';

	async function saveSettings(): Promise<void> {
		saveState = 'saving';
		saveMessage = '';
		const payload: Record<string, string> = {};
		if (settingsRepo !== site.repository) payload.repository = settingsRepo;
		if (settingsServer !== site.server) payload.server = settingsServer;
		if (settingsDesc !== site.description) payload.description = settingsDesc;

		try {
			const res = await fetch(`/api/sites/${site.slug}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(payload)
			});
			if (!res.ok) {
				const body: { error?: string } = await res.json().catch(() => ({}));
				saveState = 'error';
				saveMessage = body.error ?? `Save failed (${res.status})`;
				setTimeout(() => { saveState = 'idle'; saveMessage = ''; }, 6000);
				return;
			}
			const updated: Site = await res.json();
			data = { ...data, site: updated };
			saveState = 'saved';
			saveMessage = 'Saved';
			setTimeout(() => { saveState = 'idle'; saveMessage = ''; }, 3000);
		} catch {
			saveState = 'error';
			saveMessage = 'Network error — could not save';
			setTimeout(() => { saveState = 'idle'; saveMessage = ''; }, 6000);
		}
	}

	async function saveDeployAuth(): Promise<void> {
		if (settingsDeployAuth === 'pat' && !settingsDeployToken.trim()) {
			authSaveState = 'error';
			authSaveMessage = 'Access token required for PAT auth';
			setTimeout(() => { authSaveState = 'idle'; authSaveMessage = ''; }, 6000);
			return;
		}
		authSaveState = 'saving';
		authSaveMessage = '';
		const payload: Record<string, string> = { deploy_auth: settingsDeployAuth };
		if (settingsDeployToken.trim()) payload.deploy_token = settingsDeployToken.trim();
		try {
			const res = await fetch(`/api/sites/${site.slug}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(payload)
			});
			if (!res.ok) {
				const b: { error?: string } = await res.json().catch(() => ({}));
				authSaveState = 'error';
				authSaveMessage = b.error ?? `Save failed (${res.status})`;
				setTimeout(() => { authSaveState = 'idle'; authSaveMessage = ''; }, 6000);
				return;
			}
			const updated: Site = await res.json();
			data = { ...data, site: updated };
			settingsDeployToken = '';
			settingsDeployAuth = updated.deploy_auth;
			authSaveState = 'saved';
			authSaveMessage = 'Auth method updated';
			setTimeout(() => { authSaveState = 'idle'; authSaveMessage = ''; }, 3000);
		} catch {
			authSaveState = 'error';
			authSaveMessage = 'Network error — could not save';
			setTimeout(() => { authSaveState = 'idle'; authSaveMessage = ''; }, 6000);
		}
	}

	async function triggerDeploy(): Promise<void> {
		deployState = 'loading';
		deployMessage = '';
		try {
			const res = await fetch(`/api/sites/${site.slug}/deploy`, { method: 'POST' });
			if (res.status === 503) {
				deployState = 'unavailable';
				deployMessage = 'Deploy unavailable — Coolify not connected';
				setTimeout(() => { deployState = 'idle'; deployMessage = ''; }, 6000);
				return;
			}
			if (!res.ok) {
				const body: { error?: string } = await res.json().catch(() => ({}));
				deployState = 'error';
				deployMessage = body.error ?? `Deploy failed (${res.status})`;
				setTimeout(() => { deployState = 'idle'; deployMessage = ''; }, 6000);
				return;
			}
			deployState = 'success';
			deployMessage = 'Deploy queued';
			// Refresh deployments list
			const deploysRes = await fetch(`/api/sites/${site.slug}/deployments`);
			if (deploysRes.ok) {
				deploys = await deploysRes.json();
			}
			setTimeout(() => { deployState = 'idle'; deployMessage = ''; }, 4000);
		} catch {
			deployState = 'error';
			deployMessage = 'Network error — could not reach server';
			setTimeout(() => { deployState = 'idle'; deployMessage = ''; }, 6000);
		}
	}
	let logModal: Deploy | null = null;
	let showDeleteSiteConfirm = false;
	let deleteSiteState: 'idle' | 'deleting' | 'error' = 'idle';
	let deleteSiteError = '';

	async function deleteSite(): Promise<void> {
		deleteSiteState = 'deleting';
		deleteSiteError = '';
		try {
			const res = await fetch(`/api/sites/${site.slug}`, { method: 'DELETE' });
			if (!res.ok) {
				const body: { error?: string } = await res.json().catch(() => ({}));
				deleteSiteError = body.error ?? `Delete failed (${res.status})`;
				deleteSiteState = 'error';
				return;
			}
			window.location.href = '/';
		} catch {
			deleteSiteError = 'Network error — could not delete site';
			deleteSiteState = 'error';
		}
	}

	let showDeleteDnsConfirm: string | null = null; // stores the record ID pending confirmation, null when no dialog open
	let showAddDns = false;

	// New DNS record form state
	let newRecord = { type: 'A', name: '', value: '', ttl: 3600, priority: '' };

	// DNS add/edit state
	let editingRecord: DnsRecord | null = null;
	let dnsFormSaving = false;
	let dnsFormError = '';
	let deletingRecordId: string | null = null;
	let deleteError: string | null = null;

	function resetDnsForm() {
		newRecord = { type: 'A', name: '', value: '', ttl: 3600, priority: '' };
		editingRecord = null;
		dnsFormError = '';
		showAddDns = false;
	}

	async function addRecord(): Promise<void> {
		dnsFormSaving = true;
		dnsFormError = '';
		const isEditing = editingRecord !== null;
		const url = isEditing
			? `/api/sites/${site.slug}/dns/${editingRecord!.id}`
			: `/api/sites/${site.slug}/dns`;
		const method = isEditing ? 'PUT' : 'POST';
		const payload: Record<string, string | number | undefined> = {
			type: newRecord.type,
			name: newRecord.name,
			value: newRecord.value,
			ttl: Number(newRecord.ttl),
			priority: newRecord.priority !== '' ? Number(newRecord.priority) : undefined
		};
		try {
			const res = await fetch(url, {
				method,
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(payload)
			});
			if (!res.ok) {
				const body: { error?: string } = await res.json().catch(() => ({}));
				dnsFormError = body.error ?? `Failed to save record (${res.status})`;
				dnsFormSaving = false;
				return;
			}
			const saved: DnsRecord = await res.json();
			if (isEditing) {
				dns = dns.map((r) => (r.id === saved.id ? saved : r));
			} else {
				dns = [...dns, saved];
			}
			resetDnsForm();
		} catch {
			dnsFormError = 'Network error — could not save record';
		} finally {
			dnsFormSaving = false;
		}
	}

	function startEditRecord(record: DnsRecord): void {
		editingRecord = record;
		newRecord = {
			type: record.type,
			name: record.name,
			value: record.value,
			ttl: record.ttl,
			priority: record.priority !== undefined ? String(record.priority) : ''
		};
		showAddDns = true;
	}

	async function deleteRecord(id: string): Promise<void> {
		deletingRecordId = id;
		deleteError = null;
		try {
			const res = await fetch(`/api/sites/${site.slug}/dns/${id}`, { method: 'DELETE' });
			if (!res.ok) {
				const body: { error?: string } = await res.json().catch(() => ({}));
				deleteError = body.error ?? `Delete failed (${res.status})`;
				deletingRecordId = null;
				return;
			}
			dns = dns.filter((r) => r.id !== id);
			showDeleteDnsConfirm = null;
		} catch {
			deleteError = 'Network error — delete failed';
			deletingRecordId = null;
		}
	}

	function openLog(deploy: Deploy) {
		logModal = deploy;
	}

	function closeLog() {
		logModal = null;
	}

	function deployStatusClass(status: string): string {
		const map: Record<string, string> = {
			success: 'text-success',
			failed: 'text-danger',
			running: 'text-pending',
			pending: 'text-pending'
		};
		return map[status] ?? 'text-secondary';
	}

	function deployStatusIcon(status: string): string {
		const map: Record<string, string> = {
			success: '✓',
			failed: '✗',
			running: '◎',
			pending: '◷'
		};
		return map[status] ?? '?';
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			logModal = null;
			showDeleteDnsConfirm = null;
			showDeleteSiteConfirm = false;
			showAddDns = false;
			editingRecord = null;
		}
	}

	// ── Traffic stats ─────────────────────────────────────────────────────────
	type StatRange = '24h' | '7d' | '30d';
	const statRanges: StatRange[] = ['24h', '7d', '30d'];
	let statsRange: StatRange = '24h';
	let statsLoading = false;

	interface SiteStats {
		range: StatRange;
		requests: number;
		human_requests: number;
		bot_requests: number;
		bandwidth_bytes: number;
		error_rate: number;
		avg_ms: number | null;
		sparkline: Array<{ ts: number; requests: number }>;
	}

	let stats: SiteStats | null = null;
	let statsError = false;

	async function loadStats(range: StatRange): Promise<void> {
		statsLoading = true;
		statsError = false;
		try {
			const res = await fetch(`/api/sites/${site.slug}/stats?range=${range}`);
			if (res.ok) {
				stats = await res.json();
			} else {
				statsError = true;
			}
		} catch {
			statsError = true;
		} finally {
			statsLoading = false;
		}
	}

	function setStatsRange(r: StatRange): void {
		statsRange = r;
		loadStats(r);
	}

	function formatBytes(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
		return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
	}

	function sparklinePath(points: Array<{ ts: number; requests: number }>, w: number, h: number): string {
		if (points.length < 2) return '';
		const maxReq = Math.max(...points.map(p => p.requests), 1);
		const xs = points.map((_, i) => (i / (points.length - 1)) * w);
		const ys = points.map(p => h - (p.requests / maxReq) * (h - 2) - 1);
		return xs.map((x, i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${ys[i].toFixed(1)}`).join(' ');
	}

	// Deploy key
	let deployPublicKey = '';
	let deployKeyCopied = false;

	function parseGithubOwnerRepo(url: string): string | null {
		if (!url) return null;
		// SSH: git@github.com:owner/repo[.git]
		const sshMatch = url.match(/^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/);
		if (sshMatch) return sshMatch[1];
		// HTTPS: https://github.com/owner/repo[.git]
		const httpsMatch = url.match(/^https?:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?(?:\/.*)?$/);
		if (httpsMatch) return httpsMatch[1];
		// Short-form: owner/repo[.git]
		const shortMatch = url.match(/^([^/\s:]+\/[^/\s]+?)(?:\.git)?$/);
		if (shortMatch) return shortMatch[1];
		return null;
	}

	async function copyDeployKey(): Promise<void> {
		if (!deployPublicKey) return;
		try {
			await navigator.clipboard.writeText(deployPublicKey);
			deployKeyCopied = true;
			setTimeout(() => { deployKeyCopied = false; }, 2000);
		} catch {
			// clipboard write failed silently
		}
	}

	function openGithubDeployKeys(): void {
		// Use the live form value so the button works without requiring a save first
		const ownerRepo = parseGithubOwnerRepo(settingsRepo);
		if (!ownerRepo) return;
		window.open(`https://github.com/${ownerRepo}/settings/keys/new`, '_blank');
	}

	onMount(async () => {
		try {
			const res = await fetch('/api/config/deploy-key');
			if (res.ok) {
				const body: { public_key: string } = await res.json();
				deployPublicKey = body.public_key;
			}
		} catch {
			// silently fail — key will be empty
		}
		// Load stats for overview tab
		loadStats(statsRange);

		// Poll stats every 60s
		const statsPollTimer = setInterval(() => loadStats(statsRange), 60_000);
		return () => clearInterval(statsPollTimer);
	});
</script>

<svelte:window on:keydown={handleKeydown} />

<div class="page">
	<!-- Breadcrumb -->
	<div class="breadcrumb">
		<a href="/" class="breadcrumb-link">Sites</a>
		<span class="breadcrumb-sep">/</span>
		<span class="breadcrumb-current mono">{site.domain}</span>
	</div>

	<!-- Page header -->
	<header class="page-header">
		<div class="header-left">
			<div class="site-title-row">
				<span class="status-dot status-{site.overallStatus}"></span>
				<h1 class="page-title mono">{site.domain}</h1>
			</div>
			<div class="site-meta">
				<span>{site.description}</span>
				<span class="sep">·</span>
				<span class="mono">{site.repository}</span>
				<span class="sep">·</span>
				<span class="mono">{site.server}</span>
			</div>
		</div>
		<div class="header-actions">
			<button
				class="btn btn-ghost"
				class:btn-loading={refreshState === 'loading'}
				disabled={refreshState === 'loading'}
				on:click={refreshChecks}
			>
				{#if refreshState === 'loading'}
					<span class="spinner" aria-hidden="true"></span>Refreshing…
				{:else}
					Refresh checks
				{/if}
			</button>
			<div class="deploy-wrapper">
				<button
					class="btn btn-primary"
					class:btn-loading={deployState === 'loading'}
					disabled={deployState === 'loading'}
					on:click={triggerDeploy}
				>
					{deployState === 'loading' ? 'Deploying…' : 'Deploy'}
				</button>
				{#if deployMessage}
					<span
						class="deploy-status"
						class:deploy-status-success={deployState === 'success'}
						class:deploy-status-error={deployState === 'error'}
						class:deploy-status-unavailable={deployState === 'unavailable'}
					>{deployMessage}</span>
				{/if}
			</div>
		</div>
	</header>

	<!-- Tabs -->
	<div class="tabs">
		<button class="tab" class:tab-active={activeTab === 'overview'} on:click={() => activeTab = 'overview'}>Overview</button>
		<button class="tab" class:tab-active={activeTab === 'dns'} on:click={() => activeTab = 'dns'}>DNS Records <span class="tab-count">{dns.length}</span></button>
		<button class="tab" class:tab-active={activeTab === 'deployments'} on:click={() => activeTab = 'deployments'}>Deployments <span class="tab-count">{deploys.length}</span></button>
		<button class="tab" class:tab-active={activeTab === 'settings'} on:click={() => activeTab = 'settings'}>Settings</button>
	</div>

	<!-- Overview Tab -->
	{#if activeTab === 'overview'}
		<div class="tab-content">
			<div class="status-grid">
				<!-- HTTP -->
				<div class="status-card" class:card-danger={!site.http.reachable || (site.http.statusCode ?? 0) >= 500} class:card-warning={(site.http.statusCode ?? 0) >= 400 && (site.http.statusCode ?? 0) < 500}>
					<div class="status-card-header">
						<span class="status-card-label">HTTP</span>
						{#if site.http.reachable && (site.http.statusCode ?? 0) < 400}
							<span class="status-badge badge-success">Reachable</span>
						{:else if (site.http.statusCode ?? 0) >= 500}
							<span class="status-badge badge-danger">Server Error</span>
						{:else if !site.http.reachable}
							<span class="status-badge badge-danger">Unreachable</span>
						{:else}
							<span class="status-badge badge-warning">Client Error</span>
						{/if}
					</div>
					<div class="status-card-value mono">
						{#if site.http.statusCode !== null}
							HTTP {site.http.statusCode}
						{:else}
							—
						{/if}
					</div>
					{#if site.http.responseTimeMs !== null}
						<div class="status-card-detail text-secondary">{site.http.responseTimeMs}ms response</div>
					{/if}
					<div class="status-card-time text-muted">checked {formatRelativeTime(site.http.checkedAt)}</div>
				</div>

				<!-- SSL -->
				<div class="status-card"
					class:card-danger={!site.ssl.valid}
					class:card-warning={site.ssl.valid && site.ssl.daysUntilExpiry !== null && site.ssl.daysUntilExpiry <= 14}>
					<div class="status-card-header">
						<span class="status-card-label">SSL / TLS</span>
						{#if !site.ssl.valid}
							<span class="status-badge badge-danger">Invalid</span>
						{:else if site.ssl.daysUntilExpiry !== null && site.ssl.daysUntilExpiry <= 14}
							<span class="status-badge badge-warning">Expiring soon</span>
						{:else}
							<span class="status-badge badge-success">Valid</span>
						{/if}
					</div>
					{#if site.ssl.expiresAt}
						<div class="status-card-value mono">
							{site.ssl.daysUntilExpiry}d remaining
						</div>
						<div class="status-card-detail text-secondary">
							Issuer: {site.ssl.issuer}
						</div>
						<div class="status-card-detail text-secondary">
							Expires: {new Date(site.ssl.expiresAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
						</div>
					{:else}
						<div class="status-card-value mono text-muted">No certificate</div>
					{/if}
					<div class="status-card-time text-muted">checked {formatRelativeTime(site.ssl.checkedAt)}</div>
				</div>

				<!-- DNS -->
				<div class="status-card" class:card-danger={!site.dns.resolving} class:card-warning={site.dns.resolving && !site.dns.propagated}>
					<div class="status-card-header">
						<span class="status-card-label">DNS</span>
						{#if !site.dns.resolving && !site.dns.propagated}
							<span class="status-badge badge-pending">Propagating</span>
						{:else if !site.dns.resolving}
							<span class="status-badge badge-danger">Not Resolving</span>
						{:else}
							<span class="status-badge badge-success">Resolving</span>
						{/if}
					</div>
					<div class="status-card-value mono">
						{#if site.dns.resolving}
							Resolves OK
						{:else}
							Not resolving
						{/if}
					</div>
					<div class="status-card-detail text-secondary">
						Propagation: {site.dns.propagated ? 'Complete' : 'In progress'}
					</div>
					<div class="status-card-time text-muted">checked {formatRelativeTime(site.dns.checkedAt)}</div>
				</div>

				<!-- Last Deploy -->
				<div class="status-card" class:card-danger={deploys[0]?.status === 'failed'}>
					<div class="status-card-header">
						<span class="status-card-label">Last Deploy</span>
						{#if deploys.length === 0}
							<span class="status-badge badge-pending">None</span>
						{:else if deploys[0].status === 'success'}
							<span class="status-badge badge-success">Success</span>
						{:else if deploys[0].status === 'failed'}
							<span class="status-badge badge-danger">Failed</span>
						{:else if deploys[0].status === 'running' || deploys[0].status === 'pending'}
							<span class="status-badge badge-pending">In Progress</span>
						{/if}
					</div>
					{#if deploys.length > 0}
						{@const latest = deploys[0]}
						<div class="status-card-value mono">{latest.commitRef}</div>
						<div class="status-card-detail text-secondary truncate" title={latest.commitMessage}>
							{latest.commitMessage}
						</div>
						<div class="status-card-detail text-secondary">
							{latest.branch} · {formatRelativeTime(latest.startedAt)}
							{#if latest.durationSeconds !== null}
								· {formatDuration(latest.durationSeconds)}
							{/if}
						</div>
						<button class="btn btn-ghost btn-sm mt-8" on:click={() => openLog(latest)}>View log</button>
					{:else}
						<div class="status-card-value mono text-muted">Never deployed</div>
					{/if}
				</div>
			</div>

			<!-- Traffic Stats Panel -->
			<div class="stats-panel">
				<div class="stats-panel-header">
					<h2 class="stats-panel-title">Traffic</h2>
					<div class="range-toggle">
						{#each statRanges as r}
							<button
								class="range-btn"
								class:range-btn-active={statsRange === r}
								on:click={() => setStatsRange(r)}
							>{r}</button>
						{/each}
					</div>
				</div>

				{#if statsError}
					<p class="stats-empty">No traffic data yet — starts collecting once Traefik access logging is active.</p>
				{:else if stats !== null}
					<div class="stats-row">
						<div class="stat-item">
							<span class="stat-label">Requests</span>
							<span class="stat-value mono">{stats.requests.toLocaleString()}</span>
						</div>
						<div class="stat-item">
							<span class="stat-label">Visitors</span>
							<span class="stat-value mono">{stats.human_requests.toLocaleString()}</span>
							{#if stats.bot_requests > 0}
								<span class="stat-sub text-secondary">{stats.bot_requests.toLocaleString()} bots</span>
							{/if}
						</div>
						<div class="stat-item">
							<span class="stat-label">Data served</span>
							<span class="stat-value mono">{formatBytes(stats.bandwidth_bytes)}</span>
						</div>
						<div class="stat-item">
							<span class="stat-label">Avg response</span>
							<span class="stat-value mono">{stats.avg_ms !== null ? `${Math.round(stats.avg_ms)}ms` : '—'}</span>
						</div>
						<div class="stat-item">
							<span class="stat-label">Error rate</span>
							<span
								class="stat-value mono"
								class:text-danger={stats.error_rate > 0.05}
								class:text-warning={stats.error_rate > 0.01 && stats.error_rate <= 0.05}
							>{stats.requests > 0 ? `${(stats.error_rate * 100).toFixed(1)}%` : '—'}</span>
						</div>
					</div>

					{#if stats.sparkline.length >= 2}
						<div class="sparkline-wrap">
							<svg
								width="100%"
								height="48"
								viewBox="0 0 600 48"
								preserveAspectRatio="none"
								aria-hidden="true"
							>
								<path
									d={sparklinePath(stats.sparkline, 600, 48)}
									fill="none"
									stroke="var(--accent-teal)"
									stroke-width="1.5"
									stroke-linejoin="round"
									stroke-linecap="round"
									opacity="0.8"
								/>
							</svg>
						</div>
					{/if}
				{:else if statsLoading}
					<p class="stats-loading text-secondary">Loading…</p>
				{/if}
			</div>

			{#if site.overallStatus === 'warning' || site.overallStatus === 'error'}
				<div class="alert-banner" class:alert-danger={site.overallStatus === 'error'} class:alert-warning={site.overallStatus === 'warning'}>
					<span class="alert-icon">{site.overallStatus === 'error' ? '✗' : '⚠'}</span>
					<div>
						{#if site.overallStatus === 'error' && deploys[0]?.status === 'failed'}
							<strong>Last deploy failed.</strong> The site is running the previous build. Check the deploy log for details and fix the underlying issue before re-deploying.
						{:else if site.overallStatus === 'warning' && site.ssl.daysUntilExpiry !== null && site.ssl.daysUntilExpiry <= 14}
							<strong>SSL certificate expires in {site.ssl.daysUntilExpiry} days.</strong> Auto-renewal should have triggered by now. Verify certbot is running: <code>systemctl status certbot.timer</code>
						{/if}
					</div>
				</div>
			{/if}
		</div>
	{/if}

	<!-- DNS Tab -->
	{#if activeTab === 'dns'}
		<div class="tab-content">
			<div class="section-header">
				<div>
					<h2 class="section-title">DNS Records</h2>
					<p class="section-sub mono">{site.domain}</p>
				</div>
				<button
					class="btn btn-primary btn-sm"
					disabled={showAddDns && editingRecord !== null}
					on:click={() => { if (showAddDns) { resetDnsForm(); } else { showAddDns = true; } }}
				>
					{showAddDns ? 'Cancel' : '+ Add Record'}
				</button>
			</div>

			{#if showAddDns}
				<div class="add-record-form">
					<div class="form-title">{editingRecord ? 'Edit Record' : 'New DNS Record'}</div>
					<div class="form-row">
						<div class="form-field">
							<label for="dns-type">Type</label>
							<select id="dns-type" bind:value={newRecord.type} class="input">
								{#each ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SRV', 'CAA'] as t}
									<option value={t}>{t}</option>
								{/each}
							</select>
						</div>
						<div class="form-field">
							<label for="dns-name">Name</label>
							<input id="dns-name" bind:value={newRecord.name} placeholder="@ or subdomain" class="input mono" />
							<p class="dns-preview mono text-secondary">{newRecord.name === '@' || newRecord.name === '' ? site.domain : `${newRecord.name}.${site.domain}`}</p>
						</div>
						<div class="form-field form-field-wide">
							<label for="dns-value">Value</label>
							<input id="dns-value" bind:value={newRecord.value} placeholder="IP address or hostname" class="input mono" />
						</div>
						<div class="form-field form-field-narrow">
							<label for="dns-ttl">TTL</label>
							<input id="dns-ttl" bind:value={newRecord.ttl} type="number" class="input mono" />
						</div>
						{#if newRecord.type === 'MX' || newRecord.type === 'SRV'}
							<div class="form-field form-field-narrow">
								<label for="dns-priority">Priority</label>
								<input id="dns-priority" bind:value={newRecord.priority} type="number" class="input mono" />
							</div>
						{/if}
					</div>
					<div class="form-actions">
						<button class="btn btn-primary btn-sm" disabled={dnsFormSaving} on:click={addRecord}>
							{dnsFormSaving ? 'Saving…' : editingRecord ? 'Update Record' : 'Save Record'}
						</button>
						<button class="btn btn-ghost btn-sm" on:click={resetDnsForm}>Cancel</button>
						{#if dnsFormError}
							<span class="text-danger">{dnsFormError}</span>
						{/if}
					</div>
				</div>
			{/if}

			{#if dns.length === 0 && !showAddDns}
				<div class="dns-empty">
					<p class="text-secondary">No DNS records yet.</p>
					<button class="btn btn-ghost btn-sm" on:click={() => showAddDns = true}>+ Add first record</button>
				</div>
			{:else if dns.length > 0}
				<div class="table-wrapper">
					<table class="dns-table">
						<thead>
							<tr>
								<th>Type</th>
								<th>Name</th>
								<th>Value</th>
								<th>TTL</th>
								<th>Priority</th>
								<th></th>
							</tr>
						</thead>
						<tbody>
							{#each dns as record}
								<tr style={deletingRecordId === record.id ? 'opacity: 0.4' : ''}>
									<td>
										<span class="dns-type-badge dns-type-{record.type.toLowerCase()}">{record.type}</span>
									</td>
									<td class="mono">{record.name}</td>
									<td class="mono dns-value">{record.value}</td>
									<td class="mono text-secondary">{record.ttl}</td>
									<td class="mono text-secondary">{record.priority ?? '—'}</td>
									<td class="cell-actions">
										{#if deletingRecordId === record.id}
											<span class="text-secondary">Deleting…</span>
										{:else if deleteError && showDeleteDnsConfirm === record.id}
											<span class="text-danger">{deleteError} <button class="btn btn-ghost btn-xs" on:click={() => deleteRecord(record.id)}>Retry?</button></span>
										{:else if showDeleteDnsConfirm === record.id}
											<div class="delete-confirm">
												<span class="text-danger">Delete {record.type} {record.name}?</span>
												<button class="btn btn-danger btn-xs" on:click={() => deleteRecord(record.id)}>Confirm delete</button>
												<button class="btn btn-ghost btn-xs" on:click={() => { showDeleteDnsConfirm = null; deleteError = null; }}>Cancel</button>
											</div>
										{:else}
											<div class="row-actions">
												<button class="btn btn-ghost btn-xs" on:click={() => startEditRecord(record)}>Edit</button>
												<button class="btn btn-ghost btn-xs text-danger" on:click={() => { showDeleteDnsConfirm = record.id; deleteError = null; }}>Delete</button>
											</div>
										{/if}
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</div>
	{/if}

	<!-- Deployments Tab -->
	{#if activeTab === 'deployments'}
		<div class="tab-content">
			<div class="section-header">
				<div>
					<h2 class="section-title">Deployments</h2>
					<p class="section-sub">{deploys.length} deploy{deploys.length !== 1 ? 's' : ''}</p>
				</div>
				<button
					class="btn btn-primary btn-sm"
					class:btn-loading={deployState === 'loading'}
					disabled={deployState === 'loading'}
					on:click={triggerDeploy}
				>{deployState === 'loading' ? 'Deploying…' : 'Deploy HEAD'}</button>
			</div>

			<div class="deploys-list">
				{#each deploys as deploy}
					<div class="deploy-row" class:deploy-failed={deploy.status === 'failed'}>
						<div class="deploy-status-icon {deployStatusClass(deploy.status)}">
							{deployStatusIcon(deploy.status)}
						</div>
						<div class="deploy-main">
							<div class="deploy-top-row">
								<span class="mono deploy-commit">{deploy.commitRef}</span>
								<span class="mono deploy-branch text-secondary">{deploy.branch}</span>
								<span class="deploy-message" title={deploy.commitMessage}>{deploy.commitMessage}</span>
							</div>
							<div class="deploy-meta">
								<span class="text-secondary">{formatRelativeTime(deploy.startedAt)}</span>
								{#if deploy.durationSeconds !== null}
									<span class="sep">·</span>
									<span class="text-secondary">{formatDuration(deploy.durationSeconds)}</span>
								{/if}
								<span class="sep">·</span>
								<span class="text-secondary">by {deploy.triggeredBy}</span>
							</div>
						</div>
						<div class="deploy-actions">
							<span class="deploy-status-label {deployStatusClass(deploy.status)}">{deploy.status}</span>
							<button class="btn btn-ghost btn-sm" on:click={() => openLog(deploy)}>Log</button>
						</div>
					</div>
				{/each}
			</div>
		</div>
	{/if}

	<!-- Settings Tab -->
	{#if activeTab === 'settings'}
		<div class="tab-content">
			<div class="settings-grid">
				<div class="settings-section">
					<h2 class="section-title">Site Configuration</h2>
					<div class="settings-form">
						<div class="form-field">
							<label for="cfg-domain">Domain</label>
							<input id="cfg-domain" bind:value={settingsDomain} class="input mono" readonly />
						</div>
						<div class="form-field">
							<label for="cfg-repo">Repository</label>
							<input id="cfg-repo" bind:value={settingsRepo} class="input mono" />
						</div>
						<div class="form-field">
							<label for="cfg-server">Server</label>
							<input id="cfg-server" bind:value={settingsServer} class="input mono" />
						</div>
						<div class="form-field">
							<label for="cfg-desc">Description</label>
							<input id="cfg-desc" bind:value={settingsDesc} class="input" />
						</div>
						<div class="form-actions">
							<button
								class="btn btn-primary btn-sm"
								disabled={saveState === 'saving'}
								on:click={saveSettings}
							>
								{saveState === 'saving' ? 'Saving…' : 'Save Changes'}
							</button>
							{#if saveMessage}
								<span
									class="save-feedback"
									class:save-feedback-success={saveState === 'saved'}
									class:save-feedback-error={saveState === 'error'}
								>{saveMessage}</span>
							{/if}
						</div>
					</div>
				</div>

				<div class="settings-section">
					<h2 class="section-title">Deploy Authentication</h2>
					<div class="settings-form">
						<div class="form-field">
							<label for="cfg-deploy-auth">Method</label>
							<select id="cfg-deploy-auth" bind:value={settingsDeployAuth} class="input">
								<option value="ssh_key">SSH Key</option>
								<option value="pat">Personal Access Token (PAT)</option>
							</select>
						</div>
						{#if settingsDeployAuth === 'pat'}
							<div class="form-field">
								<label for="cfg-deploy-token">
									Access Token
									{#if site.deploy_auth === 'pat'}<span class="text-secondary"> (leave blank to keep current)</span>{/if}
								</label>
								<input
									id="cfg-deploy-token"
									type="password"
									bind:value={settingsDeployToken}
									class="input mono"
									placeholder="ghp_..."
								/>
							</div>
						{/if}
						{#if settingsDeployAuth === 'ssh_key'}
							<div class="form-field">
								<label>Deploy Key</label>
								<p class="deploy-key-hint text-secondary">Add this public key to your GitHub repository as a deploy key so HermitHost can pull your code.</p>
								{#if deployPublicKey}
									<div class="deploy-key-block">
										<code class="deploy-key-text mono">{deployPublicKey}</code>
									</div>
									<div class="form-actions" style="margin-top:8px">
										<button class="btn btn-ghost btn-sm" on:click={copyDeployKey}>
											{deployKeyCopied ? 'Copied!' : 'Copy Key'}
										</button>
										{#if parseGithubOwnerRepo(settingsRepo)}
											<button class="btn btn-primary btn-sm" on:click={openGithubDeployKeys}>
												Add to GitHub →
											</button>
										{/if}
									</div>
								{:else}
									<p class="text-secondary" style="font-size:12px">Loading deploy key…</p>
								{/if}
							</div>
						{/if}
						<div class="form-actions">
							<button
								class="btn btn-primary btn-sm"
								disabled={
									authSaveState === 'saving'
									|| (settingsDeployAuth === site.deploy_auth && settingsDeployAuth === 'ssh_key')
									|| (settingsDeployAuth === 'pat' && !settingsDeployToken.trim() && site.deploy_auth === 'pat')
								}
								on:click={saveDeployAuth}
							>
								{authSaveState === 'saving' ? 'Updating…' : 'Update Auth'}
							</button>
							{#if authSaveMessage}
								<span
									class="save-feedback"
									class:save-feedback-success={authSaveState === 'saved'}
									class:save-feedback-error={authSaveState === 'error'}
								>{authSaveMessage}</span>
							{/if}
						</div>
					</div>
				</div>

				<div class="settings-section danger-zone">
					<h2 class="section-title text-danger">Danger Zone</h2>
					<div class="danger-item">
						<div>
							<div class="danger-label">Remove site from HermitHost</div>
							<div class="danger-desc text-secondary">Removes the site from this dashboard. Does not delete files from the server or DNS records.</div>
						</div>
						{#if !showDeleteSiteConfirm}
							<button class="btn btn-danger-outline" on:click={() => { showDeleteSiteConfirm = true; deleteSiteError = ''; }}>Remove site…</button>
						{:else}
							<div class="delete-site-confirm">
								<span class="danger-desc">Remove <strong class="mono">{site.domain}</strong>?</span>
								<button
									class="btn btn-danger btn-sm"
									disabled={deleteSiteState === 'deleting'}
									on:click={deleteSite}
								>{deleteSiteState === 'deleting' ? 'Removing…' : 'Yes, remove'}</button>
								<button class="btn btn-ghost btn-sm" on:click={() => { showDeleteSiteConfirm = false; deleteSiteError = ''; }}>Cancel</button>
								{#if deleteSiteError}<span class="save-feedback save-feedback-error">{deleteSiteError}</span>{/if}
							</div>
						{/if}
					</div>
				</div>
			</div>
		</div>
	{/if}
</div>

<!-- Deploy Log Modal -->
{#if logModal !== null}
	{@const deploy = logModal}
	<!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
	<div class="modal-backdrop" on:click={closeLog} role="presentation">
		<!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
		<div class="modal" on:click|stopPropagation role="dialog" aria-modal="true" aria-label="Deploy log">
			<div class="modal-header">
				<div class="modal-title-row">
					<span class="mono deploy-commit">{deploy.commitRef}</span>
					<span class="mono text-secondary">{deploy.branch}</span>
					<span class="deploy-status-label {deployStatusClass(deploy.status)}">{deploy.status}</span>
				</div>
				<div class="modal-meta text-secondary">
					{deploy.commitMessage} · {formatRelativeTime(deploy.startedAt)}
					{#if deploy.durationSeconds !== null}
						· {formatDuration(deploy.durationSeconds)}
					{/if}
				</div>
				<button class="modal-close" on:click={closeLog} aria-label="Close log">✕</button>
			</div>
			<div class="log-output" role="log" aria-label="Deploy log output">
				{#each deploy.logLines as line}
					<div class="log-line" class:log-error={line.includes('ERROR') || line.includes('FAILED') || line.includes('✗')} class:log-success={line.includes('✓')}>
						{line}
					</div>
				{/each}
				{#if deploy.status === 'pending' || deploy.status === 'running'}
					<div class="log-cursor">▌</div>
				{/if}
			</div>
		</div>
	</div>
{/if}

<style>
	.page {
		padding: 28px 40px 60px;
		max-width: 1300px;
	}

	.breadcrumb {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-bottom: 20px;
		font-size: 12px;
	}

	.breadcrumb-link {
		color: var(--text-secondary);
		transition: color 0.1s;
	}

	.breadcrumb-link:hover {
		color: var(--text-primary);
	}

	.breadcrumb-sep {
		color: var(--text-muted);
	}

	.breadcrumb-current {
		color: var(--text-primary);
	}

	.page-header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		margin-bottom: 24px;
		gap: 16px;
	}

	.site-title-row {
		display: flex;
		align-items: center;
		gap: 10px;
		margin-bottom: 6px;
	}

	.page-title {
		font-size: 20px;
		font-weight: 600;
		color: var(--text-primary);
	}

	.site-meta {
		font-size: 12px;
		color: var(--text-secondary);
		display: flex;
		align-items: center;
		gap: 6px;
		flex-wrap: wrap;
	}

	.sep { color: var(--text-muted); }

	.header-actions {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-shrink: 0;
	}

	.status-dot {
		width: 9px;
		height: 9px;
		border-radius: 50%;
		flex-shrink: 0;
	}

	.status-healthy { background: var(--success); }
	.status-warning { background: var(--warning); box-shadow: 0 0 6px rgba(212,168,67,0.4); }
	.status-error { background: var(--danger); box-shadow: 0 0 6px rgba(207,92,92,0.4); }
	.status-pending { background: var(--pending); animation: pulse 2s infinite; }

	@keyframes pulse {
		0%, 100% { opacity: 1; }
		50% { opacity: 0.4; }
	}

	/* Tabs */
	.tabs {
		display: flex;
		border-bottom: 1px solid var(--border);
		gap: 0;
		margin-bottom: 24px;
	}

	.tab {
		background: none;
		border: none;
		border-bottom: 2px solid transparent;
		margin-bottom: -1px;
		padding: 10px 16px;
		color: var(--text-secondary);
		font-size: 13px;
		font-weight: 500;
		cursor: pointer;
		transition: color 0.1s, border-color 0.1s;
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.tab:hover {
		color: var(--text-primary);
	}

	.tab-active {
		color: var(--text-primary);
		border-bottom-color: var(--accent-teal);
	}

	.tab-count {
		background: var(--bg-elevated);
		color: var(--text-secondary);
		font-size: 10px;
		padding: 1px 5px;
		border-radius: 10px;
		border: 1px solid var(--border);
	}

	/* Status cards */
	.status-grid {
		display: grid;
		grid-template-columns: repeat(4, 1fr);
		gap: 12px;
		margin-bottom: 20px;
	}

	.status-card {
		background: var(--bg-surface);
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 16px;
	}

	.card-danger {
		border-color: rgba(207, 92, 92, 0.4);
		background: rgba(207, 92, 92, 0.05);
	}

	.card-warning {
		border-color: rgba(212, 168, 67, 0.4);
		background: rgba(212, 168, 67, 0.04);
	}

	.status-card-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 12px;
	}

	.status-card-label {
		font-size: 11px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--text-secondary);
	}

	.status-badge {
		font-size: 10px;
		font-weight: 500;
		padding: 2px 7px;
		border-radius: 3px;
	}

	.badge-success {
		background: rgba(76,175,130,0.15);
		color: var(--success);
		border: 1px solid rgba(76,175,130,0.25);
	}

	.badge-danger {
		background: rgba(207,92,92,0.15);
		color: var(--danger);
		border: 1px solid rgba(207,92,92,0.25);
	}

	.badge-warning {
		background: rgba(212,168,67,0.15);
		color: var(--warning);
		border: 1px solid rgba(212,168,67,0.25);
	}

	.badge-pending {
		background: rgba(139,157,195,0.15);
		color: var(--pending);
		border: 1px solid rgba(139,157,195,0.25);
	}

	.status-card-value {
		font-size: 20px;
		font-weight: 500;
		color: var(--text-primary);
		margin-bottom: 4px;
	}

	.status-card-detail {
		font-size: 12px;
		margin-bottom: 2px;
	}

	.status-card-time {
		font-size: 11px;
		margin-top: 8px;
	}

	.truncate {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		max-width: 200px;
	}

	/* Alert banner */
	.alert-banner {
		display: flex;
		align-items: flex-start;
		gap: 12px;
		padding: 14px 16px;
		border-radius: 7px;
		font-size: 13px;
	}

	.alert-danger {
		background: rgba(207,92,92,0.12);
		border: 1px solid rgba(207,92,92,0.35);
		color: #e8a0a0;
	}

	.alert-warning {
		background: rgba(212,168,67,0.1);
		border: 1px solid rgba(212,168,67,0.3);
		color: #dfc07a;
	}

	.alert-icon {
		font-size: 14px;
		margin-top: 1px;
		flex-shrink: 0;
	}

	.alert-banner code {
		font-family: var(--font-mono);
		font-size: 12px;
		background: rgba(0,0,0,0.2);
		padding: 1px 5px;
		border-radius: 3px;
	}

	/* Section headers */
	.section-header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		margin-bottom: 16px;
	}

	.section-title {
		font-size: 15px;
		font-weight: 600;
		color: var(--text-primary);
		margin-bottom: 2px;
	}

	.section-sub {
		font-size: 12px;
		color: var(--text-secondary);
	}

	/* DNS table */
	.table-wrapper {
		background: var(--bg-surface);
		border: 1px solid var(--border);
		border-radius: 8px;
		overflow: hidden;
	}

	.dns-table td:last-child {
		text-align: right;
	}

	.dns-value {
		font-size: 12px;
		max-width: 400px;
		word-break: break-all;
	}

	.dns-type-badge {
		font-family: var(--font-mono);
		font-size: 11px;
		font-weight: 500;
		padding: 2px 7px;
		border-radius: 3px;
		border: 1px solid var(--border-bright);
		background: var(--bg-elevated);
	}

	.dns-type-a { color: #7ab5e8; border-color: rgba(122,181,232,0.3); background: rgba(122,181,232,0.08); }
	.dns-type-aaaa { color: #7ab5e8; border-color: rgba(122,181,232,0.3); background: rgba(122,181,232,0.08); }
	.dns-type-cname { color: #a8e6a3; border-color: rgba(168,230,163,0.3); background: rgba(168,230,163,0.08); }
	.dns-type-mx { color: #e8c87a; border-color: rgba(232,200,122,0.3); background: rgba(232,200,122,0.08); }
	.dns-type-txt { color: #c8a8e8; border-color: rgba(200,168,232,0.3); background: rgba(200,168,232,0.08); }
	.dns-type-ns { color: var(--text-secondary); }
	.dns-type-srv { color: #e87a9a; border-color: rgba(232,122,154,0.3); background: rgba(232,122,154,0.08); }
	.dns-type-caa { color: var(--accent-amber); border-color: rgba(212,168,67,0.3); background: rgba(212,168,67,0.08); }

	.row-actions {
		display: flex;
		gap: 6px;
		justify-content: flex-end;
	}

	.delete-confirm {
		display: flex;
		align-items: center;
		gap: 8px;
		justify-content: flex-end;
	}

	/* Deploy list */
	.deploys-list {
		display: flex;
		flex-direction: column;
		gap: 1px;
		background: var(--border);
		border: 1px solid var(--border);
		border-radius: 8px;
		overflow: hidden;
	}

	.deploy-row {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 14px 16px;
		background: var(--bg-surface);
		transition: background 0.1s;
	}

	.deploy-row:hover {
		background: var(--bg-hover);
	}

	.deploy-failed {
		border-left: 2px solid var(--danger);
	}

	.deploy-status-icon {
		font-size: 16px;
		font-family: var(--font-mono);
		width: 20px;
		text-align: center;
		flex-shrink: 0;
	}

	.deploy-main {
		flex: 1;
		min-width: 0;
	}

	.deploy-top-row {
		display: flex;
		align-items: center;
		gap: 10px;
		margin-bottom: 4px;
	}

	.deploy-commit {
		font-size: 13px;
		font-weight: 500;
		color: var(--accent-teal);
	}

	.deploy-branch {
		font-size: 11px;
		background: var(--bg-elevated);
		padding: 1px 6px;
		border-radius: 3px;
		border: 1px solid var(--border-bright);
	}

	.deploy-message {
		font-size: 13px;
		color: var(--text-primary);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		min-width: 0;
	}

	.deploy-meta {
		font-size: 12px;
		color: var(--text-secondary);
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.deploy-actions {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-shrink: 0;
	}

	.deploy-status-label {
		font-size: 11px;
		font-family: var(--font-mono);
		font-weight: 500;
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}

	/* Add DNS form */
	.add-record-form {
		background: var(--bg-surface);
		border: 1px solid var(--border-bright);
		border-radius: 8px;
		padding: 16px;
		margin-bottom: 16px;
	}

	.form-title {
		font-size: 13px;
		font-weight: 500;
		color: var(--text-primary);
		margin-bottom: 14px;
	}

	.form-row {
		display: flex;
		gap: 10px;
		align-items: flex-end;
		flex-wrap: wrap;
	}

	.form-field {
		display: flex;
		flex-direction: column;
		gap: 5px;
		min-width: 120px;
	}

	.form-field-wide {
		flex: 1;
		min-width: 200px;
	}

	.form-field-narrow {
		min-width: 80px;
		max-width: 100px;
	}

	label {
		font-size: 11px;
		font-weight: 500;
		text-transform: uppercase;
		letter-spacing: 0.07em;
		color: var(--text-secondary);
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

	.input[readonly] {
		opacity: 0.6;
		cursor: default;
	}

	select.input {
		cursor: pointer;
	}

	.form-actions {
		display: flex;
		gap: 8px;
		margin-top: 14px;
	}

	/* Buttons */
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
		cursor: pointer;
		font-family: var(--font-ui);
	}

	.btn-primary {
		background: var(--accent-teal);
		color: #fff;
	}

	.btn-primary:hover { background: var(--accent-teal-dim); }

	.btn-ghost {
		background: transparent;
		color: var(--text-secondary);
		border: 1px solid var(--border-bright);
	}

	.btn-ghost:hover {
		background: var(--bg-hover);
		color: var(--text-primary);
	}

	.btn-danger-outline {
		background: transparent;
		color: var(--danger);
		border: 1px solid rgba(207,92,92,0.4);
	}

	.btn-danger-outline:hover {
		background: rgba(207,92,92,0.1);
	}

	.btn-danger {
		background: var(--danger);
		color: #fff;
	}

	.btn-sm {
		font-size: 12px;
		padding: 5px 10px;
	}

	.btn-xs {
		font-size: 11px;
		padding: 3px 8px;
	}

	.mt-8 { margin-top: 8px; }

	/* Settings */
	.settings-grid {
		display: flex;
		flex-direction: column;
		gap: 32px;
		max-width: 560px;
	}

	.settings-section {
		background: var(--bg-surface);
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 20px;
	}

	.settings-section .section-title {
		margin-bottom: 16px;
		padding-bottom: 12px;
		border-bottom: 1px solid var(--border);
	}

	.settings-form {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.danger-zone {
		border-color: rgba(207,92,92,0.3);
	}

	.danger-item {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
	}

	.delete-site-confirm {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
	}

	.danger-label {
		font-size: 13px;
		font-weight: 500;
		color: var(--text-primary);
		margin-bottom: 4px;
	}

	.danger-desc {
		font-size: 12px;
	}

	/* Modal */
	.modal-backdrop {
		position: fixed;
		inset: 0;
		background: rgba(0,0,0,0.7);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 100;
		padding: 24px;
	}

	.modal {
		background: var(--bg-surface);
		border: 1px solid var(--border-bright);
		border-radius: 10px;
		width: 100%;
		max-width: 820px;
		max-height: 80vh;
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}

	.modal-header {
		padding: 16px 20px;
		border-bottom: 1px solid var(--border);
		position: relative;
		flex-shrink: 0;
	}

	.modal-title-row {
		display: flex;
		align-items: center;
		gap: 10px;
		margin-bottom: 4px;
	}

	.modal-meta {
		font-size: 12px;
	}

	.modal-close {
		position: absolute;
		top: 14px;
		right: 16px;
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

	.log-output {
		flex: 1;
		overflow-y: auto;
		padding: 16px 20px;
		background: #070d18;
		font-family: var(--font-mono);
		font-size: 12px;
		line-height: 1.7;
	}

	.log-line {
		color: #8fa3c0;
		white-space: pre-wrap;
		word-break: break-all;
	}

	.log-error {
		color: #e88080;
	}

	.log-success {
		color: #7dd3a8;
	}

	.log-cursor {
		color: var(--accent-teal);
		animation: blink 1s step-end infinite;
	}

	@keyframes blink {
		0%, 100% { opacity: 1; }
		50% { opacity: 0; }
	}

	/* Deploy button */
	.deploy-wrapper {
		display: flex;
		align-items: center;
		gap: 10px;
	}

	.btn-loading {
		opacity: 0.7;
		cursor: not-allowed;
	}

	.deploy-status {
		font-size: 12px;
		font-weight: 500;
	}

	.deploy-status-success {
		color: var(--accent-teal);
	}

	.deploy-status-error {
		color: var(--danger);
	}

	.deploy-status-unavailable {
		color: var(--accent-amber);
	}

	/* Spinner */
	.spinner {
		display: inline-block;
		width: 12px;
		height: 12px;
		border: 2px solid var(--border-bright);
		border-top-color: var(--text-secondary);
		border-radius: 50%;
		animation: spin 0.6s linear infinite;
		flex-shrink: 0;
	}

	@keyframes spin {
		to { transform: rotate(360deg); }
	}

	/* Save feedback */
	.save-feedback {
		font-size: 12px;
		font-weight: 500;
	}

	.save-feedback-success {
		color: var(--accent-teal);
	}

	.save-feedback-error {
		color: var(--danger);
	}

	/* DNS empty state */
	.dns-empty {
		text-align: center;
		padding: 2rem;
		border: 1px dashed var(--border);
		border-radius: 6px;
	}

	/* DNS domain preview */
	.dns-preview {
		font-size: 0.75rem;
		margin-top: 0.25rem;
		margin-bottom: 0;
	}

	/* Deploy key */
	.deploy-key-hint {
		font-size: 12px;
		margin: 0;
	}

	.deploy-key-block {
		background: var(--bg-elevated);
		border: 1px solid var(--border-bright);
		border-radius: 5px;
		padding: 10px 12px;
		overflow-x: auto;
	}

	.deploy-key-text {
		font-size: 11px;
		color: var(--text-secondary);
		word-break: break-all;
		white-space: pre-wrap;
		display: block;
	}

	/* Traffic stats panel */
	.stats-panel {
		background: var(--bg-surface);
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 16px 20px;
		margin-bottom: 20px;
	}

	.stats-panel-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 16px;
	}

	.stats-panel-title {
		font-size: 13px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.07em;
		color: var(--text-secondary);
	}

	.range-toggle {
		display: flex;
		border: 1px solid var(--border-bright);
		border-radius: 4px;
		overflow: hidden;
	}

	.range-btn {
		background: transparent;
		border: none;
		border-right: 1px solid var(--border-bright);
		color: var(--text-secondary);
		font-size: 11px;
		font-weight: 500;
		padding: 4px 10px;
		cursor: pointer;
		transition: background 0.1s, color 0.1s;
		font-family: var(--font-mono);
	}

	.range-btn:last-child {
		border-right: none;
	}

	.range-btn:hover {
		background: var(--bg-hover);
		color: var(--text-primary);
	}

	.range-btn-active {
		background: var(--accent-teal);
		color: #fff;
	}

	.range-btn-active:hover {
		background: var(--accent-teal-dim);
		color: #fff;
	}

	.stats-row {
		display: flex;
		gap: 32px;
		flex-wrap: wrap;
		margin-bottom: 16px;
	}

	.stat-item {
		display: flex;
		flex-direction: column;
		gap: 3px;
		min-width: 80px;
	}

	.stat-label {
		font-size: 11px;
		font-weight: 500;
		text-transform: uppercase;
		letter-spacing: 0.07em;
		color: var(--text-muted);
	}

	.stat-value {
		font-size: 22px;
		font-weight: 500;
		color: var(--text-primary);
		line-height: 1.1;
	}

	.stat-sub {
		font-size: 11px;
		font-family: var(--font-mono);
	}

	.sparkline-wrap {
		width: 100%;
		height: 48px;
		border-top: 1px solid var(--border);
		padding-top: 8px;
		overflow: hidden;
	}

	.sparkline-wrap svg {
		display: block;
		width: 100%;
		height: 40px;
	}

	.stats-empty {
		font-size: 12px;
		color: var(--text-secondary);
		padding: 8px 0;
		margin: 0;
	}

	.stats-loading {
		font-size: 12px;
		padding: 8px 0;
		margin: 0;
	}
</style>
