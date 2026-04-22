<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import type { PageData } from './$types';
	import type { ServiceContainer, ServiceGroup, ServicesResponse, RestoreEvent } from '$lib/types';

	export let data: PageData;

	$: services = data.services as ServicesResponse;
	$: stackGroups = services.stackGroups ?? [];
	$: siteGroups = services.siteGroups ?? [];
	$: allStackContainers = stackGroups.flatMap(g => g.containers);
	$: allSiteContainers = siteGroups.flatMap(g => g.containers);
	$: restoreEvent = services.restoreEvent as RestoreEvent | null;

	// ── Section collapse state ────────────────────────────────────────────────
	$: allStackHealthy = allStackContainers.every(c => c.status === 'running');
	let stackExpanded = true;
	let sitesExpanded = true;
	$: stackExpanded = !allStackHealthy; // auto-expand when degraded

	// ── Per-container action pending state ───────────────────────────────────
	let pending: Record<string, string> = {};

	// ── Auto-refresh ─────────────────────────────────────────────────────────
	let lastUpdated = new Date();
	let lastUpdatedLabel = 'just now';
	let pollTimer: ReturnType<typeof setInterval>;
	let labelTimer: ReturnType<typeof setInterval>;

	function startPolling() {
		pollTimer = setInterval(async () => {
			if (document.visibilityState === 'hidden') return;
			await invalidateAll();
			lastUpdated = new Date();
		}, 10_000);
		labelTimer = setInterval(() => {
			const secs = Math.round((Date.now() - lastUpdated.getTime()) / 1000);
			lastUpdatedLabel = secs < 5 ? 'just now' : `${secs}s ago`;
		}, 1000);
	}

	function handleVisibilityChange() {
		if (document.visibilityState === 'visible') {
			invalidateAll().then(() => { lastUpdated = new Date(); });
		}
	}

	onMount(() => {
		startPolling();
		document.addEventListener('visibilitychange', handleVisibilityChange);
	});

	onDestroy(() => {
		clearInterval(pollTimer);
		clearInterval(labelTimer);
		document.removeEventListener('visibilitychange', handleVisibilityChange);
	});

	async function refresh() {
		await invalidateAll();
		lastUpdated = new Date();
	}

	// ── Restore banner dismiss ────────────────────────────────────────────────
	let restoreDismissed = false;
	let restoreAutoDismissTimer: ReturnType<typeof setTimeout>;
	$: if (restoreEvent && !restoreDismissed) {
		clearTimeout(restoreAutoDismissTimer);
		if (restoreEvent.failed.length === 0) {
			restoreAutoDismissTimer = setTimeout(() => { restoreDismissed = true; }, 60_000);
		}
	}

	// ── Container actions ─────────────────────────────────────────────────────
	async function containerAction(id: string, action: 'start' | 'stop' | 'restart') {
		pending = { ...pending, [id]: action };
		try {
			await fetch(`/api/services/${id}/${action}`, { method: 'POST' });
			await new Promise(r => setTimeout(r, 300));
			await invalidateAll();
			lastUpdated = new Date();
		} finally {
			const { [id]: _, ...rest } = pending;
			pending = rest;
		}
	}

	// ── Stop confirmation modal ───────────────────────────────────────────────
	let stopTarget: ServiceContainer | null = null;

	function promptStop(container: ServiceContainer) {
		stopTarget = container;
	}

	async function confirmStop() {
		if (!stopTarget) return;
		const id = stopTarget.id;
		stopTarget = null;
		await containerAction(id, 'stop');
	}

	// ── Delete confirmation modal ─────────────────────────────────────────────
	let deleteTarget: ServiceContainer | null = null;

	function promptDelete(container: ServiceContainer) {
		deleteTarget = container;
	}

	async function confirmDelete() {
		if (!deleteTarget) return;
		const id = deleteTarget.id;
		deleteTarget = null;
		pending = { ...pending, [id]: 'delete' };
		try {
			await fetch(`/api/services/${id}`, { method: 'DELETE' });
			await new Promise(r => setTimeout(r, 300));
			await invalidateAll();
			lastUpdated = new Date();
		} finally {
			const { [id]: _, ...rest } = pending;
			pending = rest;
		}
	}

	// ── Overflow menu ─────────────────────────────────────────────────────────
	let openMenu: string | null = null;

	function toggleMenu(id: string) {
		openMenu = openMenu === id ? null : id;
	}

	function closeMenus() { openMenu = null; }

	// ── Shutdown modal ────────────────────────────────────────────────────────
	let showShutdownModal = false;
	let shutdownConfirmText = '';
	let shutdownInProgress = false;
	let shutdownDone = false;

	$: shutdownConfirmValid = shutdownConfirmText.trim() === 'shutdown all';

	async function executeShutdown() {
		if (!shutdownConfirmValid) return;
		shutdownInProgress = true;
		try {
			await fetch('/api/services/shutdown', { method: 'POST' });
			shutdownDone = true;
		} catch {
			// Connection likely dropped — stack is shutting down
			shutdownDone = true;
		}
	}

	// ── Helpers ───────────────────────────────────────────────────────────────
	function statusClass(status: string): string {
		if (status === 'running') return 'badge-running';
		if (status === 'exited' || status === 'dead') return 'badge-exited';
		return 'badge-stopped';
	}

	function formatUptime(uptime: string | null, status: string): string {
		if (!uptime) return '—';
		if (status !== 'running') {
			// Docker gives "Exited (137) 12 minutes ago" — extract time part
			const m = uptime.match(/(\d+\s+\w+\s+ago)/);
			return m ? `stopped ${m[1]}` : uptime;
		}
		// Running: "Up 3 hours" → "3 hours"
		return uptime.replace(/^Up\s+/, '');
	}
</script>

<svelte:window on:click={closeMenus} />

<div class="page">
	<!-- ── Page header ──────────────────────────────────────────────────────── -->
	<div class="page-header">
		<h1 class="page-title">Services</h1>
		<div class="header-actions">
			<span class="updated-label">Updated {lastUpdatedLabel}</span>
			<button class="btn-secondary" on:click={refresh}>Refresh</button>
			<button class="btn-danger" on:click={() => { showShutdownModal = true; shutdownConfirmText = ''; shutdownDone = false; }}>
				Shutdown Stack
			</button>
		</div>
	</div>

	<!-- ── Restore banner ───────────────────────────────────────────────────── -->
	{#if restoreEvent && !restoreDismissed}
		<div class="restore-banner" class:restore-partial={restoreEvent.failed.length > 0}>
			{#if restoreEvent.failed.length === 0}
				<span>Full stack restored — {restoreEvent.restored}/{restoreEvent.total} containers online</span>
			{:else}
				<span>
					Restore incomplete — {restoreEvent.restored}/{restoreEvent.total} containers online —
					failed: {restoreEvent.failed.join(', ')}
				</span>
			{/if}
			<button class="banner-dismiss" on:click={() => { restoreDismissed = true; }}>✕</button>
		</div>
	{/if}

	<!-- ── Stack Services (grouped) ────────────────────────────────────────── -->
	<div class="section">
		<button
			class="section-header"
			aria-expanded={stackExpanded}
			on:click={() => { stackExpanded = !stackExpanded; }}
		>
			<span class="section-title">Stack Services</span>
			<span class="section-meta">
				{allStackContainers.filter(c => c.status === 'running').length}/{allStackContainers.length} running
				{#if allStackHealthy}
					<span class="badge-healthy">healthy</span>
				{:else}
					<span class="badge-degraded">degraded</span>
				{/if}
			</span>
			<svg class="chevron" class:rotated={!stackExpanded} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
				<polyline points="6 9 12 15 18 9"/>
			</svg>
		</button>

		{#if stackExpanded}
			{#if stackGroups.length === 0}
				<div class="empty-sites">No stack services found</div>
			{:else}
				{#each stackGroups as group (group.id)}
					<div class="site-group">
						<div class="site-group-header">
							<div class="site-group-identity">
								<span class="site-group-name">{group.name}</span>
							</div>
							<span class="site-group-meta">
								{group.containers.filter(c => c.status === 'running').length}/{group.containers.length} running
							</span>
						</div>
						<table class="site-table">
							<thead>
								<tr>
									<th class="th-indent">Service</th>
									<th>Status</th>
									<th>Uptime</th>
									<th>Image</th>
									<th style="text-align:right">Actions</th>
								</tr>
							</thead>
							<tbody aria-live="polite">
								{#each group.containers as container (container.id)}
									<tr>
										<td class="td-indent cell-name">{container.name}</td>
										<td>
											<span class="status-badge {statusClass(container.status)}">
												{container.status}
											</span>
										</td>
										<td class="cell-muted">{formatUptime(container.uptime, container.status)}</td>
										<td class="cell-mono cell-muted">{container.image}</td>
										<td class="cell-actions">
											{#if container.status !== 'running'}
												<button
													class="btn-action btn-start"
													disabled={!!pending[container.id]}
													aria-label="Start {container.name}"
													on:click={() => containerAction(container.id, 'start')}
												>
													{pending[container.id] === 'start' ? '…' : 'Start'}
												</button>
											{:else}
												<div class="action-group">
													<button
														class="btn-action btn-restart"
														disabled={!!pending[container.id]}
														aria-label="Restart {container.name}"
														on:click={() => containerAction(container.id, 'restart')}
													>
														{pending[container.id] === 'restart' ? '…' : 'Restart'}
													</button>
													<div class="overflow-wrap">
														<button
															class="btn-overflow"
															aria-label="More actions for {container.name}"
															on:click|stopPropagation={() => toggleMenu(container.id)}
														>⋯</button>
														{#if openMenu === container.id}
															<div class="overflow-menu">
																<button
																	class="overflow-item overflow-danger"
																	on:click|stopPropagation={() => { closeMenus(); promptStop(container); }}
																>Stop</button>
															</div>
														{/if}
													</div>
												</div>
											{/if}
										</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				{/each}
			{/if}
		{/if}
	</div>

	<!-- ── Sites Rail (Deployed Sites — grouped by site) ───────────────────── -->
	<div class="section">
		<button
			class="section-header"
			aria-expanded={sitesExpanded}
			on:click={() => { sitesExpanded = !sitesExpanded; }}
		>
			<span class="section-title">Deployed Sites</span>
			<span class="section-meta">
				{allSiteContainers.filter(c => c.status === 'running').length}/{allSiteContainers.length} running
				· {siteGroups.length} site{siteGroups.length !== 1 ? 's' : ''}
			</span>
			<svg class="chevron" class:rotated={!sitesExpanded} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
				<polyline points="6 9 12 15 18 9"/>
			</svg>
		</button>

		{#if sitesExpanded}
			{#if siteGroups.length === 0}
				<div class="empty-sites">No deployed site containers found</div>
			{:else}
				{#each siteGroups as group (group.id)}
					<div class="site-group">
						<!-- Site header row -->
						<div class="site-group-header" class:site-group-abandoned={group.abandoned}>
							<div class="site-group-identity">
								<span class="site-group-name">{group.name}</span>
								{#if group.abandoned}
									<span class="badge-abandoned">abandoned</span>
								{:else if group.domain}
									<a
										class="site-group-domain"
										href="https://{group.domain}"
										target="_blank"
										rel="noopener noreferrer"
									>{group.domain}</a>
								{/if}
							</div>
							<span class="site-group-meta">
								{group.containers.filter(c => c.status === 'running').length}/{group.containers.length} running
							</span>
						</div>
						<!-- Containers under this site -->
						<table class="site-table">
							<thead>
								<tr>
									<th class="th-indent">Container</th>
									<th>Status</th>
									<th>Uptime</th>
									<th>Image</th>
									<th style="text-align:right">Actions</th>
								</tr>
							</thead>
							<tbody aria-live="polite">
								{#each group.containers as container (container.id)}
									<tr>
										<td class="td-indent">
											<span class="cell-mono cell-dim">{container.name}</span>
										</td>
										<td>
											<span class="status-badge {statusClass(container.status)}">
												{container.status}
											</span>
										</td>
										<td class="cell-muted">{formatUptime(container.uptime, container.status)}</td>
										<td class="cell-mono cell-muted">{container.image}</td>
										<td class="cell-actions">
											{#if group.abandoned}
												<button
													class="btn-action btn-delete"
													disabled={!!pending[container.id]}
													aria-label="Delete {container.name}"
													on:click={() => promptDelete(container)}
												>
													{pending[container.id] === 'delete' ? '…' : 'Delete'}
												</button>
											{:else if container.status !== 'running'}
												<button
													class="btn-action btn-start"
													disabled={!!pending[container.id]}
													aria-label="Start {container.name}"
													on:click={() => containerAction(container.id, 'start')}
												>
													{pending[container.id] === 'start' ? '…' : 'Start'}
												</button>
											{:else}
												<div class="action-group">
													<button
														class="btn-action btn-restart"
														disabled={!!pending[container.id]}
														aria-label="Restart {container.name}"
														on:click={() => containerAction(container.id, 'restart')}
													>
														{pending[container.id] === 'restart' ? '…' : 'Restart'}
													</button>
													<div class="overflow-wrap">
														<button
															class="btn-overflow"
															aria-label="More actions for {container.name}"
															on:click|stopPropagation={() => toggleMenu(container.id)}
														>⋯</button>
														{#if openMenu === container.id}
															<div class="overflow-menu">
																<button
																	class="overflow-item overflow-danger"
																	on:click|stopPropagation={() => { closeMenus(); promptStop(container); }}
																>Stop</button>
															</div>
														{/if}
													</div>
												</div>
											{/if}
										</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				{/each}
			{/if}
		{/if}
	</div>
</div>

<!-- ── Stop confirmation modal ──────────────────────────────────────────────── -->
{#if stopTarget}
	<div class="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="stop-modal-title">
		<div class="modal">
			<h2 id="stop-modal-title" class="modal-title">Stop container?</h2>
			<p class="modal-body">
				<span class="mono">{stopTarget.name}</span> will be stopped.
				Dependent services may be affected.
			</p>
			<div class="modal-actions">
				<button class="btn-secondary" on:click={() => { stopTarget = null; }}>Cancel</button>
				<button class="btn-danger-sm" on:click={confirmStop}>Stop</button>
			</div>
		</div>
	</div>
{/if}

<!-- ── Delete confirmation modal ─────────────────────────────────────────────── -->
{#if deleteTarget}
	<div class="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="delete-modal-title">
		<div class="modal">
			<h2 id="delete-modal-title" class="modal-title modal-title-danger">Delete abandoned container?</h2>
			<p class="modal-body">
				<span class="mono">{deleteTarget.name}</span> will be force-removed.
				This container is no longer tracked by Coolify and cannot be recovered.
			</p>
			<div class="modal-actions">
				<button class="btn-secondary" on:click={() => { deleteTarget = null; }}>Cancel</button>
				<button class="btn-danger-sm" on:click={confirmDelete}>Delete</button>
			</div>
		</div>
	</div>
{/if}

<!-- ── Shutdown modal ────────────────────────────────────────────────────────── -->
{#if showShutdownModal}
	<div class="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="shutdown-modal-title">
		<div class="modal modal-wide">
			{#if shutdownDone}
				<h2 id="shutdown-modal-title" class="modal-title">Stack shutting down</h2>
				<p class="modal-body">
					Coolify containers stopped and checkpointed. The HermitHost stack is shutting down.
					This page will become unreachable momentarily.
				</p>
				<div class="modal-actions">
					<button class="btn-secondary" on:click={() => { showShutdownModal = false; }}>Close</button>
				</div>
			{:else}
				<h2 id="shutdown-modal-title" class="modal-title modal-title-danger">Shutdown Stack</h2>
				<p class="modal-body">
					This will stop all <strong>{allSiteContainers.length} deployed site container{allSiteContainers.length !== 1 ? 's' : ''}</strong> across {siteGroups.length} site{siteGroups.length !== 1 ? 's' : ''},
					checkpoint them for restore, then shut down the HermitHost stack.
					Your sites will be unreachable until the stack is restarted.
				</p>
				<div class="confirm-input-group">
					<label class="confirm-label" for="shutdown-confirm">
						Type <span class="mono">shutdown all</span> to confirm
					</label>
					<input
						id="shutdown-confirm"
						class="confirm-input"
						type="text"
						bind:value={shutdownConfirmText}
						placeholder="shutdown all"
						autocomplete="off"
					/>
				</div>
				<div class="modal-actions">
					<button class="btn-secondary" on:click={() => { showShutdownModal = false; }}>Cancel</button>
					<button
						class="btn-danger-sm"
						disabled={!shutdownConfirmValid || shutdownInProgress}
						on:click={executeShutdown}
					>
						{shutdownInProgress ? 'Shutting down…' : 'Shut Down Stack'}
					</button>

				</div>
			{/if}
		</div>
	</div>
{/if}

<style>
	.page {
		padding: 32px 32px 64px;
		max-width: 1100px;
	}

	.page-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 24px;
		gap: 12px;
	}

	.page-title {
		font-size: 20px;
		font-weight: 600;
		color: var(--text-primary);
	}

	.header-actions {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.updated-label {
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--text-muted);
		margin-right: 4px;
	}

	/* ── Restore banner ────────────────────────────────────────────────────── */
	.restore-banner {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 10px 14px;
		border-radius: 6px;
		background: rgba(59, 138, 140, 0.08);
		border: 1px solid var(--accent-teal-dim);
		color: var(--accent-teal);
		font-size: 13px;
		margin-bottom: 20px;
	}

	.restore-banner.restore-partial {
		background: rgba(212, 168, 67, 0.08);
		border-color: rgba(212, 168, 67, 0.3);
		color: var(--warning);
	}

	.banner-dismiss {
		background: none;
		border: none;
		color: inherit;
		opacity: 0.6;
		cursor: pointer;
		font-size: 12px;
		padding: 2px 4px;
		flex-shrink: 0;
	}

	.banner-dismiss:hover { opacity: 1; }

	/* ── Section ───────────────────────────────────────────────────────────── */
	.section {
		background: var(--bg-surface);
		border: 1px solid var(--border);
		border-radius: 8px;
		margin-bottom: 16px;
		overflow: hidden;
	}

	.section-header {
		display: flex;
		align-items: center;
		gap: 10px;
		width: 100%;
		padding: 12px 16px;
		background: none;
		border: none;
		color: var(--text-primary);
		cursor: pointer;
		text-align: left;
		border-bottom: 1px solid var(--border);
		transition: background 0.1s;
	}

	.section-header:hover { background: var(--bg-hover); }

	.section-title {
		font-size: 13px;
		font-weight: 600;
	}

	.section-meta {
		font-size: 12px;
		color: var(--text-muted);
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.chevron {
		margin-left: auto;
		color: var(--text-muted);
		transition: transform 0.15s;
	}

	.chevron.rotated { transform: rotate(-90deg); }

	.badge-healthy {
		font-size: 10px;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		background: rgba(76, 175, 130, 0.1);
		color: var(--success);
		border: 1px solid rgba(76, 175, 130, 0.2);
		padding: 1px 6px;
		border-radius: 3px;
	}

	.badge-degraded {
		font-size: 10px;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		background: rgba(207, 92, 92, 0.1);
		color: var(--danger);
		border: 1px solid rgba(207, 92, 92, 0.2);
		padding: 1px 6px;
		border-radius: 3px;
	}

	/* ── Table ─────────────────────────────────────────────────────────────── */
	.table-wrap { overflow-x: auto; }

	/* ── Site groups ───────────────────────────────────────────────────────── */
	.empty-sites {
		padding: 24px;
		text-align: center;
		color: var(--text-muted);
		font-size: 12px;
	}

	.site-group {
		border-bottom: 1px solid var(--border);
	}

	.site-group:last-child { border-bottom: none; }

	.site-group-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 10px 16px;
		background: var(--bg-elevated);
		border-bottom: 1px solid var(--border);
	}

	.site-group-identity {
		display: flex;
		align-items: center;
		gap: 10px;
	}

	.site-group-name {
		font-size: 13px;
		font-weight: 600;
		color: var(--text-primary);
	}

	.site-group-domain {
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--accent-teal);
		opacity: 0.8;
		transition: opacity 0.1s;
	}

	.site-group-domain:hover { opacity: 1; }

	.site-group-abandoned { opacity: 0.7; }

	.badge-abandoned {
		font-size: 10px;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		background: rgba(212, 168, 67, 0.1);
		color: var(--warning);
		border: 1px solid rgba(212, 168, 67, 0.25);
		padding: 1px 6px;
		border-radius: 3px;
	}

	.site-group-meta {
		font-size: 11px;
		color: var(--text-muted);
		font-family: var(--font-mono);
	}

	.site-table { width: 100%; }

	.th-indent, .td-indent { padding-left: 28px; }

	.cell-dim { color: var(--text-muted); }

	.cell-name {
		font-family: var(--font-mono);
		font-size: 12px;
		color: var(--text-primary);
	}

	.cell-mono {
		font-family: var(--font-mono);
		font-size: 11px;
	}

	.cell-muted { color: var(--text-muted); }

	.site-slug {
		display: block;
		font-size: 10px;
		font-family: var(--font-mono);
		color: var(--text-muted);
		margin-top: 2px;
	}

	.cell-empty {
		text-align: center;
		color: var(--text-muted);
		font-size: 12px;
		padding: 24px;
	}

	.cell-actions {
		text-align: right;
		white-space: nowrap;
	}

	/* ── Status badges ─────────────────────────────────────────────────────── */
	.status-badge {
		display: inline-flex;
		align-items: center;
		padding: 2px 7px;
		border-radius: 3px;
		font-size: 10px;
		font-weight: 500;
		font-family: var(--font-mono);
		text-transform: uppercase;
		letter-spacing: 0.05em;
		white-space: nowrap;
	}

	.badge-running {
		background: rgba(76, 175, 130, 0.1);
		color: var(--success);
		border: 1px solid rgba(76, 175, 130, 0.2);
	}

	.badge-exited {
		background: rgba(207, 92, 92, 0.1);
		color: var(--danger);
		border: 1px solid rgba(207, 92, 92, 0.2);
	}

	.badge-stopped {
		background: rgba(212, 168, 67, 0.1);
		color: var(--warning);
		border: 1px solid rgba(212, 168, 67, 0.2);
	}

	/* ── Action buttons ────────────────────────────────────────────────────── */
	.action-group {
		display: inline-flex;
		align-items: center;
		gap: 4px;
	}

	.btn-action {
		padding: 4px 10px;
		border-radius: 4px;
		font-size: 11px;
		font-weight: 500;
		border: 1px solid var(--border-bright);
		background: var(--bg-elevated);
		color: var(--text-secondary);
		cursor: pointer;
		transition: background 0.1s, color 0.1s;
		min-width: 54px;
	}

	.btn-action:hover:not(:disabled) {
		background: var(--bg-hover);
		color: var(--text-primary);
	}

	.btn-action:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.btn-start:hover:not(:disabled) {
		border-color: rgba(76, 175, 130, 0.4);
		color: var(--success);
	}

	.btn-delete {
		border-color: rgba(207, 92, 92, 0.3);
		color: var(--danger);
	}

	.btn-delete:hover:not(:disabled) {
		border-color: rgba(207, 92, 92, 0.5);
		background: rgba(207, 92, 92, 0.08);
		color: var(--danger);
	}

	.btn-overflow {
		padding: 4px 8px;
		border-radius: 4px;
		font-size: 14px;
		border: 1px solid var(--border-bright);
		background: var(--bg-elevated);
		color: var(--text-muted);
		cursor: pointer;
		line-height: 1;
	}

	.btn-overflow:hover {
		background: var(--bg-hover);
		color: var(--text-secondary);
	}

	.overflow-wrap {
		position: relative;
	}

	.overflow-menu {
		position: absolute;
		right: 0;
		top: calc(100% + 4px);
		background: var(--bg-elevated);
		border: 1px solid var(--border-bright);
		border-radius: 5px;
		min-width: 100px;
		z-index: 100;
		box-shadow: 0 4px 16px rgba(0,0,0,0.3);
	}

	.overflow-item {
		display: block;
		width: 100%;
		padding: 8px 12px;
		background: none;
		border: none;
		text-align: left;
		font-size: 12px;
		color: var(--text-secondary);
		cursor: pointer;
	}

	.overflow-item:hover { background: var(--bg-hover); color: var(--text-primary); }
	.overflow-danger:hover { color: var(--danger); }

	/* ── Buttons (page-level) ──────────────────────────────────────────────── */
	.btn-secondary {
		padding: 6px 14px;
		border-radius: 5px;
		font-size: 12px;
		font-weight: 500;
		border: 1px solid var(--border-bright);
		background: var(--bg-elevated);
		color: var(--text-secondary);
		cursor: pointer;
		transition: background 0.1s, color 0.1s;
	}

	.btn-secondary:hover {
		background: var(--bg-hover);
		color: var(--text-primary);
	}

	.btn-danger {
		padding: 6px 14px;
		border-radius: 5px;
		font-size: 12px;
		font-weight: 500;
		border: 1px solid rgba(207, 92, 92, 0.3);
		background: rgba(207, 92, 92, 0.08);
		color: var(--danger);
		cursor: pointer;
		transition: background 0.1s;
	}

	.btn-danger:hover { background: rgba(207, 92, 92, 0.14); }

	.btn-danger-sm {
		padding: 7px 16px;
		border-radius: 5px;
		font-size: 12px;
		font-weight: 500;
		border: 1px solid rgba(207, 92, 92, 0.4);
		background: rgba(207, 92, 92, 0.12);
		color: var(--danger);
		cursor: pointer;
		transition: background 0.1s;
	}

	.btn-danger-sm:hover:not(:disabled) { background: rgba(207, 92, 92, 0.2); }
	.btn-danger-sm:disabled { opacity: 0.4; cursor: not-allowed; }

	/* ── Modals ────────────────────────────────────────────────────────────── */
	.modal-backdrop {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.6);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 200;
	}

	.modal {
		background: var(--bg-surface);
		border: 1px solid var(--border-bright);
		border-radius: 8px;
		padding: 24px;
		width: 380px;
		max-width: calc(100vw - 40px);
	}

	.modal-wide { width: 460px; }

	.modal-title {
		font-size: 15px;
		font-weight: 600;
		margin-bottom: 12px;
	}

	.modal-title-danger { color: var(--danger); }

	.modal-body {
		font-size: 13px;
		color: var(--text-secondary);
		line-height: 1.6;
		margin-bottom: 20px;
	}

	.modal-actions {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
	}

	.mono {
		font-family: var(--font-mono);
		font-size: 12px;
		background: var(--bg-elevated);
		padding: 1px 5px;
		border-radius: 3px;
		color: var(--text-primary);
	}

	.confirm-input-group {
		margin-bottom: 20px;
	}

	.confirm-label {
		display: block;
		font-size: 12px;
		color: var(--text-secondary);
		margin-bottom: 8px;
	}

	.confirm-input {
		width: 100%;
		padding: 8px 10px;
		background: var(--bg-elevated);
		border: 1px solid var(--border-bright);
		border-radius: 5px;
		color: var(--text-primary);
		font-family: var(--font-mono);
		font-size: 13px;
	}

	.confirm-input:focus {
		outline: none;
		border-color: var(--accent-teal-dim);
	}
</style>
