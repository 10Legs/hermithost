<script lang="ts">
	import type { PageData } from './$types';
	import type { DnsZone } from './+page';
	import type { DnsRecord } from '$lib/types';

	export let data: PageData;

	let zones: DnsZone[] = data.zones;
	let nsHostname: string | null = data.nsHostname;
	let helpExpanded = false;
	let helpDismissed = false;

	// Auto-expand on first visit (no zones yet) unless already dismissed
	if (typeof localStorage !== 'undefined') {
		helpDismissed = localStorage.getItem('hermithost:dns-help-dismissed') === '1';
	}
	if (!helpDismissed && zones.length === 0) {
		helpExpanded = true;
	}

	function dismissHelp(): void {
		helpDismissed = true;
		helpExpanded = false;
		if (typeof localStorage !== 'undefined') {
			localStorage.setItem('hermithost:dns-help-dismissed', '1');
		}
	}

	function copyNs(): void {
		if (nsHostname) navigator.clipboard.writeText(nsHostname);
	}

	let selectedZone: DnsZone | null = null;
	let zoneRecords: DnsRecord[] = [];
	let recordsLoading = false;
	let recordsError = '';

	// Zone create form
	let showAddZone = false;
	let newZoneName = '';
	let addZoneLoading = false;
	let addZoneError = '';

	// Zone delete
	let deletingZone: string | null = null;
	let deleteZoneError = '';
	let showDeleteZoneConfirm: string | null = null;

	// DNS record form
	let showAddDns = false;
	let editingRecord: DnsRecord | null = null;
	let newRecord = { type: 'A', name: '', value: '', ttl: 3600, priority: '' };
	let dnsFormSaving = false;
	let dnsFormError = '';

	// Record delete
	let showDeleteRecordConfirm: string | null = null;
	let deletingRecordId: string | null = null;
	let deleteRecordError: string | null = null;

	// ── Zone helpers ─────────────────────────────────────────────────────────────

	const userZones = () => zones.filter((z) => !z.internal);
	const internalZones = () => zones.filter((z) => z.internal);

	async function selectZone(zone: DnsZone): Promise<void> {
		selectedZone = zone;
		zoneRecords = [];
		recordsError = '';
		recordsLoading = true;
		resetDnsForm();
		try {
			const res = await fetch(`/api/dns/zones/${encodeURIComponent(zone.name)}/records`);
			if (!res.ok) {
				const body: { error?: string } = await res.json().catch(() => ({}));
				recordsError = body.error ?? `Failed to load records (${res.status})`;
				return;
			}
			zoneRecords = await res.json();
		} catch {
			recordsError = 'Network error — could not load records';
		} finally {
			recordsLoading = false;
		}
	}

	async function createZone(): Promise<void> {
		if (!newZoneName.trim()) return;
		addZoneLoading = true;
		addZoneError = '';
		try {
			const res = await fetch('/api/dns/zones', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name: newZoneName.trim() })
			});
			if (!res.ok) {
				const body: { error?: string } = await res.json().catch(() => ({}));
				addZoneError = body.error ?? `Create failed (${res.status})`;
				return;
			}
			const created: DnsZone = await res.json();
			const fullZone: DnsZone = { disabled: false, internal: false, dnssecStatus: 'Unsigned', ...created };
			zones = [...zones, fullZone];
			newZoneName = '';
			showAddZone = false;
			await selectZone(fullZone);
		} catch {
			addZoneError = 'Network error — could not create zone';
		} finally {
			addZoneLoading = false;
		}
	}

	async function deleteZone(name: string): Promise<void> {
		deletingZone = name;
		deleteZoneError = '';
		try {
			const res = await fetch(`/api/dns/zones/${encodeURIComponent(name)}`, { method: 'DELETE' });
			if (!res.ok) {
				const body: { error?: string } = await res.json().catch(() => ({}));
				deleteZoneError = body.error ?? `Delete failed (${res.status})`;
				deletingZone = null;
				return;
			}
			zones = zones.filter((z) => z.name !== name);
			if (selectedZone?.name === name) {
				selectedZone = null;
				zoneRecords = [];
			}
			showDeleteZoneConfirm = null;
			deletingZone = null;
		} catch {
			deleteZoneError = 'Network error — delete failed';
			deletingZone = null;
		}
	}

	// ── Record helpers ────────────────────────────────────────────────────────────

	function resetDnsForm(): void {
		newRecord = { type: 'A', name: '', value: '', ttl: 3600, priority: '' };
		editingRecord = null;
		dnsFormError = '';
		showAddDns = false;
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

	async function saveRecord(): Promise<void> {
		if (!selectedZone) return;
		dnsFormSaving = true;
		dnsFormError = '';
		const isEditing = editingRecord !== null;
		const url = isEditing
			? `/api/dns/zones/${encodeURIComponent(selectedZone.name)}/records/${editingRecord!.id}`
			: `/api/dns/zones/${encodeURIComponent(selectedZone.name)}/records`;
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
				zoneRecords = zoneRecords.map((r) => (r.id === saved.id ? saved : r));
			} else {
				zoneRecords = [...zoneRecords, saved];
			}
			resetDnsForm();
		} catch {
			dnsFormError = 'Network error — could not save record';
		} finally {
			dnsFormSaving = false;
		}
	}

	async function deleteRecord(id: string): Promise<void> {
		if (!selectedZone) return;
		deletingRecordId = id;
		deleteRecordError = null;
		try {
			const res = await fetch(
				`/api/dns/zones/${encodeURIComponent(selectedZone.name)}/records/${id}`,
				{ method: 'DELETE' }
			);
			if (!res.ok) {
				const body: { error?: string } = await res.json().catch(() => ({}));
				deleteRecordError = body.error ?? `Delete failed (${res.status})`;
				deletingRecordId = null;
				return;
			}
			zoneRecords = zoneRecords.filter((r) => r.id !== id);
			showDeleteRecordConfirm = null;
		} catch {
			deleteRecordError = 'Network error — delete failed';
			deletingRecordId = null;
		}
	}

	function handleKeydown(e: KeyboardEvent): void {
		if (e.key === 'Escape') {
			showAddDns = false;
			editingRecord = null;
			showDeleteZoneConfirm = null;
			showDeleteRecordConfirm = null;
			showAddZone = false;
		}
	}
</script>

<svelte:window on:keydown={handleKeydown} />

<div class="dns-page">
	<header class="page-header">
		<h1 class="page-title">DNS Management</h1>
		<p class="page-sub">Manage zones and records on your Technitium DNS server.</p>
	</header>

	{#if !helpDismissed}
		<div class="help-banner" class:expanded={helpExpanded}>
			<div class="help-banner-header">
				<button class="help-toggle" on:click={() => helpExpanded = !helpExpanded}>
					<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
						<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
					</svg>
					How to point your domain at HermitHost
					<svg class="chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
						<polyline points={helpExpanded ? '18 15 12 9 6 15' : '6 9 12 15 18 9'}/>
					</svg>
				</button>
				<div class="help-ns-chip">
					NS:
					{#if nsHostname}
						<span class="ns-value mono">{nsHostname}</span>
						<button class="copy-btn" on:click={copyNs} title="Copy nameserver address">
							<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
						</button>
					{:else}
						<span class="ns-placeholder mono" title="Set NS_HOSTNAME in your .env to show your server address">&lt;your-server-ip&gt;</span>
					{/if}
				</div>
				<button class="help-dismiss" on:click={dismissHelp} title="Dismiss">
					<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
				</button>
			</div>

			{#if helpExpanded}
				<ol class="help-steps">
					<li><strong>Create a zone</strong> — click <code>+</code> in the zone list and enter your domain (e.g. <code>mysite.com</code>).</li>
					<li><strong>Add your DNS records</strong> — at minimum an A record pointing <code>@</code> to your server's IP.</li>
					<li><strong>Update nameservers at your registrar</strong> — log in to Namecheap, GoDaddy, Cloudflare Registrar, or wherever your domain is registered. Find the Nameservers section and replace the existing entries with your HermitHost server address{nsHostname ? `: ${nsHostname}` : ' (set NS_HOSTNAME in .env)'}.</li>
					<li><strong>Wait for propagation</strong> — changes typically take effect within an hour, but can take up to 48 hours. Check progress at <a href="https://dnschecker.org" target="_blank" rel="noopener noreferrer">dnschecker.org</a>.</li>
				</ol>
			{/if}
		</div>
	{/if}

	<div class="dns-layout">
		<!-- ── Zone list ─────────────────────────────────────────────────────────── -->
		<aside class="zone-list">
			<div class="zone-list-header">
				<span class="zone-list-title">Zones</span>
				<button class="btn-icon" title="Add zone" on:click={() => { showAddZone = !showAddZone; addZoneError = ''; }}>
					<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
				</button>
			</div>

			{#each userZones() as zone (zone.name)}
				<button
					class="zone-item"
					class:active={selectedZone?.name === zone.name}
					class:disabled-zone={zone.disabled}
					on:click={() => selectZone(zone)}
				>
					<span class="zone-name mono">{zone.name}</span>
					<span class="zone-type-badge">{zone.type}</span>
				</button>
			{/each}

			{#if internalZones().length > 0}
				<div class="zone-divider">— Internal —</div>
				{#each internalZones() as zone (zone.name)}
					<button
						class="zone-item zone-internal"
						class:active={selectedZone?.name === zone.name}
						on:click={() => selectZone(zone)}
					>
						<span class="zone-name mono">{zone.name}</span>
						<span class="zone-type-badge">{zone.type}</span>
					</button>
				{/each}
			{/if}

			{#if zones.length === 0}
				<div class="zone-empty">No zones yet.</div>
			{/if}

			<!-- Add zone form -->
			{#if showAddZone}
				<form class="add-zone-form" on:submit|preventDefault={createZone}>
					<input
						class="input-sm"
						type="text"
						placeholder="example.com"
						bind:value={newZoneName}
						disabled={addZoneLoading}
						autocomplete="off"
					/>
					{#if addZoneError}
						<span class="form-error">{addZoneError}</span>
					{/if}
					<div class="add-zone-actions">
						<button class="btn btn-primary btn-sm" type="submit" disabled={addZoneLoading || !newZoneName.trim()}>
							{addZoneLoading ? 'Creating…' : 'Create'}
						</button>
						<button class="btn btn-ghost btn-sm" type="button" on:click={() => { showAddZone = false; newZoneName = ''; addZoneError = ''; }}>
							Cancel
						</button>
					</div>
				</form>
			{/if}
		</aside>

		<!-- ── Records pane ──────────────────────────────────────────────────────── -->
		<section class="records-pane">
			{#if !selectedZone}
				<div class="records-empty-state">
					<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.3"><circle cx="12" cy="12" r="10"/><path d="M12 8v4l3 3"/></svg>
					<p>Select a zone to manage its records.</p>
				</div>
			{:else}
				<!-- Zone header -->
				<div class="records-header">
					<div class="records-header-left">
						<h2 class="records-zone-name mono">{selectedZone.name}</h2>
						<span class="zone-type-badge">{selectedZone.type}</span>
						{#if selectedZone.disabled}
							<span class="badge-disabled">Disabled</span>
						{/if}
					</div>
					<div class="records-header-actions">
						<button
							class="btn btn-ghost btn-sm"
							on:click={() => { showDeleteZoneConfirm = selectedZone && selectedZone.name; }}
						>
							Delete zone
						</button>
						<button class="btn btn-primary btn-sm" on:click={() => { showAddDns = true; editingRecord = null; resetDnsForm(); showAddDns = true; }}>
							+ Add record
						</button>
					</div>
				</div>

				<!-- Delete zone confirm -->
				{#if showDeleteZoneConfirm === selectedZone.name}
					<div class="confirm-bar">
						<span>Delete zone <strong class="mono">{selectedZone.name}</strong> and all its records?</span>
						<button
							class="btn btn-danger btn-sm"
							disabled={deletingZone === selectedZone.name}
							on:click={() => selectedZone && deleteZone(selectedZone.name)}
						>
							{deletingZone === selectedZone.name ? 'Deleting…' : 'Delete'}
						</button>
						<button class="btn btn-ghost btn-sm" on:click={() => { showDeleteZoneConfirm = null; }}>Cancel</button>
						{#if deleteZoneError}<span class="form-error">{deleteZoneError}</span>{/if}
					</div>
				{/if}

				<!-- Add / edit record form -->
				{#if showAddDns}
					<form class="dns-form" on:submit|preventDefault={saveRecord}>
						<div class="dns-form-row">
							<div class="form-field">
								<label class="form-label" for="dns-type">Type</label>
								<select id="dns-type" class="select-sm" bind:value={newRecord.type} disabled={dnsFormSaving}>
									{#each ['A','AAAA','CNAME','MX','TXT','NS','SRV','CAA'] as t}
										<option value={t}>{t}</option>
									{/each}
								</select>
							</div>
							<div class="form-field form-field-grow">
								<label class="form-label" for="dns-name">Name</label>
								<input id="dns-name" class="input-sm mono" type="text" placeholder="@ or subdomain" bind:value={newRecord.name} disabled={dnsFormSaving} />
							</div>
							<div class="form-field form-field-grow">
								<label class="form-label" for="dns-value">Value</label>
								<input id="dns-value" class="input-sm mono" type="text" placeholder="1.2.3.4" bind:value={newRecord.value} disabled={dnsFormSaving} />
							</div>
							<div class="form-field form-field-narrow">
								<label class="form-label" for="dns-ttl">TTL</label>
								<input id="dns-ttl" class="input-sm mono" type="number" min="60" bind:value={newRecord.ttl} disabled={dnsFormSaving} />
							</div>
							{#if newRecord.type === 'MX' || newRecord.type === 'SRV'}
								<div class="form-field form-field-narrow">
									<label class="form-label" for="dns-priority">Priority</label>
									<input id="dns-priority" class="input-sm mono" type="number" min="0" bind:value={newRecord.priority} disabled={dnsFormSaving} />
								</div>
							{/if}
						</div>
						{#if dnsFormError}
							<span class="form-error">{dnsFormError}</span>
						{/if}
						<div class="dns-form-actions">
							<button class="btn btn-primary btn-sm" type="submit" disabled={dnsFormSaving || !newRecord.name || !newRecord.value}>
								{dnsFormSaving ? 'Saving…' : editingRecord ? 'Update record' : 'Add record'}
							</button>
							<button class="btn btn-ghost btn-sm" type="button" on:click={resetDnsForm}>Cancel</button>
						</div>
					</form>
				{/if}

				<!-- Records table -->
				{#if recordsLoading}
					<div class="records-loading">Loading records…</div>
				{:else if recordsError}
					<div class="records-error">{recordsError}</div>
				{:else if zoneRecords.length === 0}
					<div class="records-empty">No records in this zone. Add one above.</div>
				{:else}
					<table class="dns-table">
						<thead>
							<tr>
								<th>Type</th>
								<th>Name</th>
								<th>Value</th>
								<th>TTL</th>
								<th></th>
							</tr>
						</thead>
						<tbody>
							{#each zoneRecords as record (record.id)}
								<tr>
									<td><span class="record-type-badge record-type-{record.type.toLowerCase()}">{record.type}</span></td>
									<td class="mono">{record.name}</td>
									<td class="mono value-cell">{record.value}{record.priority !== undefined ? ` (prio ${record.priority})` : ''}</td>
									<td class="mono muted">{record.ttl}</td>
									<td class="record-actions">
										{#if showDeleteRecordConfirm === record.id}
											<span class="confirm-inline">
												<button
													class="btn btn-danger btn-xs"
													disabled={deletingRecordId === record.id}
													on:click={() => deleteRecord(record.id)}
												>
													{deletingRecordId === record.id ? '…' : 'Delete'}
												</button>
												<button class="btn btn-ghost btn-xs" on:click={() => { showDeleteRecordConfirm = null; }}>Cancel</button>
											</span>
										{:else}
											<button class="btn-row-action" on:click={() => startEditRecord(record)}>Edit</button>
											<button class="btn-row-action btn-row-danger" on:click={() => { showDeleteRecordConfirm = record.id; deleteRecordError = null; }}>Delete</button>
										{/if}
									</td>
								</tr>
								{#if deleteRecordError && showDeleteRecordConfirm === record.id}
									<tr class="error-row"><td colspan="5"><span class="form-error">{deleteRecordError}</span></td></tr>
								{/if}
							{/each}
						</tbody>
					</table>
				{/if}
			{/if}
		</section>
	</div>
</div>

<style>
	.dns-page {
		padding: 32px 40px;
		max-width: 1200px;
	}

	.page-header {
		margin-bottom: 28px;
	}

	.page-title {
		font-size: 20px;
		font-weight: 600;
		color: var(--text-primary);
		margin: 0 0 4px;
	}

	.page-sub {
		font-size: 13px;
		color: var(--text-muted);
		margin: 0;
	}

	/* ── Layout ─────────────────────────────────────────────────────────────────── */

	.dns-layout {
		display: flex;
		gap: 0;
		border: 1px solid var(--border);
		border-radius: 8px;
		overflow: hidden;
		min-height: 480px;
	}

	/* ── Zone list ──────────────────────────────────────────────────────────────── */

	.zone-list {
		width: 280px;
		min-width: 280px;
		border-right: 1px solid var(--border);
		background: var(--bg-surface);
		display: flex;
		flex-direction: column;
	}

	.zone-list-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 12px 14px 8px;
		border-bottom: 1px solid var(--border);
	}

	.zone-list-title {
		font-size: 11px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--text-muted);
	}

	.btn-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 22px;
		height: 22px;
		border-radius: 4px;
		color: var(--text-secondary);
		background: transparent;
		border: none;
		cursor: pointer;
		transition: background 0.1s, color 0.1s;
	}

	.btn-icon:hover {
		background: var(--bg-hover);
		color: var(--text-primary);
	}

	.zone-item {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 9px 14px;
		cursor: pointer;
		border: none;
		background: transparent;
		text-align: left;
		color: var(--text-secondary);
		font-size: 13px;
		transition: background 0.1s, color 0.1s;
		width: 100%;
		gap: 8px;
	}

	.zone-item:hover {
		background: var(--bg-hover);
		color: var(--text-primary);
	}

	.zone-item.active {
		background: var(--bg-hover);
		color: var(--text-primary);
	}

	.zone-item.disabled-zone {
		opacity: 0.5;
	}

	.zone-item.zone-internal {
		opacity: 0.55;
	}

	.zone-name {
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 12.5px;
	}

	.zone-type-badge {
		font-size: 10px;
		font-family: var(--font-mono);
		background: var(--bg-elevated);
		color: var(--text-muted);
		border: 1px solid var(--border);
		border-radius: 3px;
		padding: 1px 5px;
		flex-shrink: 0;
	}

	.zone-divider {
		font-size: 10px;
		color: var(--text-muted);
		text-align: center;
		padding: 8px 0 4px;
		opacity: 0.6;
	}

	.zone-empty {
		padding: 20px 14px;
		font-size: 12px;
		color: var(--text-muted);
		text-align: center;
	}

	/* Add zone form */

	.add-zone-form {
		padding: 10px 12px;
		border-top: 1px solid var(--border);
		display: flex;
		flex-direction: column;
		gap: 6px;
		margin-top: auto;
	}

	.add-zone-actions {
		display: flex;
		gap: 6px;
	}

	/* ── Records pane ───────────────────────────────────────────────────────────── */

	.records-pane {
		flex: 1;
		min-width: 0;
		background: var(--bg-base);
		display: flex;
		flex-direction: column;
	}

	.records-empty-state {
		flex: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 12px;
		color: var(--text-muted);
		font-size: 13px;
	}

	.records-empty-state p { margin: 0; }

	.records-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 14px 20px;
		border-bottom: 1px solid var(--border);
		gap: 12px;
		flex-wrap: wrap;
	}

	.records-header-left {
		display: flex;
		align-items: center;
		gap: 10px;
	}

	.records-zone-name {
		font-size: 15px;
		font-weight: 600;
		color: var(--text-primary);
		margin: 0;
	}

	.badge-disabled {
		font-size: 10px;
		background: var(--bg-elevated);
		color: var(--text-muted);
		border: 1px solid var(--border);
		border-radius: 3px;
		padding: 1px 6px;
	}

	.records-header-actions {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	/* Confirm bar */

	.confirm-bar {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 10px 20px;
		background: var(--bg-elevated);
		border-bottom: 1px solid var(--border);
		font-size: 13px;
		color: var(--text-primary);
		flex-wrap: wrap;
	}

	/* DNS form */

	.dns-form {
		padding: 14px 20px;
		border-bottom: 1px solid var(--border);
		background: var(--bg-surface);
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.dns-form-row {
		display: flex;
		gap: 10px;
		flex-wrap: wrap;
		align-items: flex-end;
	}

	.form-field {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.form-field-grow { flex: 1; min-width: 120px; }
	.form-field-narrow { width: 80px; }

	.form-label {
		font-size: 11px;
		color: var(--text-muted);
		font-weight: 500;
	}

	.dns-form-actions {
		display: flex;
		gap: 8px;
	}

	/* States */

	.records-loading, .records-error, .records-empty {
		padding: 40px 20px;
		font-size: 13px;
		color: var(--text-muted);
		text-align: center;
	}

	.records-error { color: var(--danger, #e05252); }

	/* Table */

	.dns-table {
		width: 100%;
		border-collapse: collapse;
		font-size: 13px;
	}

	.dns-table thead th {
		padding: 10px 16px;
		font-size: 11px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--text-muted);
		text-align: left;
		border-bottom: 1px solid var(--border);
		background: var(--bg-surface);
	}

	.dns-table tbody tr {
		border-bottom: 1px solid var(--border);
		transition: background 0.1s;
	}

	.dns-table tbody tr:last-child { border-bottom: none; }
	.dns-table tbody tr:hover { background: var(--bg-hover); }

	.dns-table td {
		padding: 10px 16px;
		color: var(--text-primary);
		vertical-align: middle;
	}

	.value-cell {
		max-width: 280px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.muted { color: var(--text-muted); }

	.record-type-badge {
		font-size: 10px;
		font-family: var(--font-mono);
		font-weight: 600;
		border-radius: 3px;
		padding: 2px 6px;
		background: var(--bg-elevated);
		color: var(--text-secondary);
		border: 1px solid var(--border);
	}

	.record-type-a    { color: #4ade80; border-color: #4ade8044; background: #4ade8012; }
	.record-type-aaaa { color: #60a5fa; border-color: #60a5fa44; background: #60a5fa12; }
	.record-type-cname { color: #a78bfa; border-color: #a78bfa44; background: #a78bfa12; }
	.record-type-mx   { color: #fb923c; border-color: #fb923c44; background: #fb923c12; }
	.record-type-txt  { color: #facc15; border-color: #facc1544; background: #facc1512; }
	.record-type-ns   { color: #94a3b8; border-color: #94a3b844; background: #94a3b812; }

	.record-actions {
		text-align: right;
		white-space: nowrap;
	}

	.confirm-inline {
		display: inline-flex;
		gap: 6px;
		align-items: center;
	}

	.error-row td { padding: 4px 16px 10px; }

	/* Shared small inputs */

	.input-sm {
		height: 30px;
		padding: 0 8px;
		font-size: 12px;
		background: var(--bg-base);
		border: 1px solid var(--border);
		border-radius: 5px;
		color: var(--text-primary);
		width: 100%;
		box-sizing: border-box;
	}

	.input-sm:focus { outline: none; border-color: var(--accent-teal); }
	.input-sm:disabled { opacity: 0.5; cursor: not-allowed; }

	.select-sm {
		height: 30px;
		padding: 0 6px;
		font-size: 12px;
		background: var(--bg-base);
		border: 1px solid var(--border);
		border-radius: 5px;
		color: var(--text-primary);
		width: 100%;
		cursor: pointer;
	}

	.select-sm:focus { outline: none; border-color: var(--accent-teal); }
	.select-sm:disabled { opacity: 0.5; cursor: not-allowed; }

	/* Buttons */

	.btn { display: inline-flex; align-items: center; gap: 6px; border: none; border-radius: 5px; cursor: pointer; font-size: 13px; font-weight: 500; transition: background 0.1s, color 0.1s; }
	.btn:disabled { opacity: 0.5; cursor: not-allowed; }

	.btn-sm { height: 30px; padding: 0 12px; font-size: 12px; }
	.btn-xs { height: 24px; padding: 0 8px; font-size: 11px; }

	.btn-primary { background: var(--accent-teal); color: #fff; }
	.btn-primary:hover:not(:disabled) { filter: brightness(1.1); }

	.btn-ghost { background: transparent; color: var(--text-secondary); border: 1px solid var(--border); }
	.btn-ghost:hover:not(:disabled) { background: var(--bg-hover); color: var(--text-primary); }

	.btn-danger { background: var(--danger, #e05252); color: #fff; }
	.btn-danger:hover:not(:disabled) { filter: brightness(1.1); }

	.btn-row-action {
		background: none;
		border: none;
		cursor: pointer;
		font-size: 12px;
		color: var(--text-muted);
		padding: 2px 6px;
		border-radius: 3px;
		transition: color 0.1s, background 0.1s;
	}
	.btn-row-action:hover { color: var(--text-primary); background: var(--bg-hover); }
	.btn-row-danger:hover { color: var(--danger, #e05252); }

	.form-error {
		font-size: 12px;
		color: var(--danger, #e05252);
	}

	.mono { font-family: var(--font-mono); }

	/* ── Help banner ────────────────────────────────────────────────────────────── */
	.help-banner {
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--bg-surface);
		margin-bottom: 16px;
		overflow: hidden;
	}

	.help-banner-header {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 10px 14px;
	}

	.help-toggle {
		display: flex;
		align-items: center;
		gap: 7px;
		background: none;
		border: none;
		cursor: pointer;
		font-size: 13px;
		color: var(--text-secondary);
		flex: 1;
		text-align: left;
	}

	.help-toggle:hover { color: var(--text-primary); }
	.help-toggle svg:first-child { color: var(--accent-teal); flex-shrink: 0; }
	.chevron { margin-left: auto; flex-shrink: 0; }

	.help-ns-chip {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 11px;
		color: var(--text-muted);
		background: var(--bg-elevated);
		border: 1px solid var(--border);
		border-radius: 4px;
		padding: 3px 8px;
		white-space: nowrap;
	}

	.ns-value { color: var(--accent-teal); }
	.ns-placeholder { color: #f59e0b; }

	.copy-btn {
		background: none;
		border: none;
		cursor: pointer;
		color: var(--text-muted);
		display: flex;
		align-items: center;
		padding: 0;
	}
	.copy-btn:hover { color: var(--text-primary); }

	.help-dismiss {
		background: none;
		border: none;
		cursor: pointer;
		color: var(--text-muted);
		display: flex;
		align-items: center;
		padding: 2px;
		border-radius: 3px;
		flex-shrink: 0;
	}
	.help-dismiss:hover { color: var(--text-primary); background: var(--bg-hover); }

	.help-steps {
		padding: 12px 20px 14px 36px;
		margin: 0;
		display: flex;
		flex-direction: column;
		gap: 8px;
		border-top: 1px solid var(--border);
	}

	.help-steps li {
		font-size: 13px;
		color: var(--text-secondary);
		line-height: 1.5;
	}

	.help-steps strong { color: var(--text-primary); }
	.help-steps code {
		font-family: var(--font-mono);
		font-size: 12px;
		background: var(--bg-elevated);
		border: 1px solid var(--border);
		border-radius: 3px;
		padding: 1px 4px;
	}
	.help-steps a { color: var(--accent-teal); text-decoration: none; }
	.help-steps a:hover { text-decoration: underline; }
</style>
