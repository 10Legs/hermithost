<script lang="ts">
	import { onMount } from 'svelte';

	// ── Types ──────────────────────────────────────────────────────────────────
	type SiteSummary = { name: string; domain: string };
	type ZoneSummary = { name: string };

	type ValidationResult = {
		valid: boolean;
		errors: string[];
		warnings: string[];
		summary: { sites: number; dns_zones: number; dns_records: number };
	};

	type ImportResult = {
		sites: { created: string[]; skipped: string[]; failed: string[] };
		dns: { created: string[]; skipped: string[]; failed: string[] };
	};

	// ── Config section ─────────────────────────────────────────────────────────
	let nsHostname = '';
	let nsServerIp = '';
	let acmeEmail = '';
	let coolifyStatus: 'connected' | 'error' | 'not_configured' = 'not_configured';
	let technitiumStatus: 'connected' | 'error' | 'not_configured' = 'not_configured';
	let coolifyUrl = '';
	let technitiumUrl = '';
	let savingConfig = false;
	let configSaveError = '';
	let configSaveSuccess = false;

	// ── DNS Provider ───────────────────────────────────────────────────────────
	let dnsProvider: 'technitium' | 'cloudflare' = 'technitium';
	let cloudflareStatus: 'connected' | 'disconnected' | 'unconfigured' = 'unconfigured';
	let cloudflareTokenInput = '';
	let networkMode: 'external' | 'internal' = 'external';
	let savingNetworkMode = false;
	let networkModeError = '';
	let networkModeWarning = '';
	let showTrustInstall = false;
	let downloadingTrustCert = false;
	let dnsForwarder1 = '';
	let dnsForwarder2 = '';
	let savingForwarders = false;
	let forwarderSaveSuccess = false;
	let forwarderSaveError = '';

	// ── DNS Recursion ──────────────────────────────────────────────────────────
	type RecursionMode = 'Disabled' | 'LanOnly' | 'Public';
	const recursionLabels: Record<RecursionMode, string> = {
		Disabled: 'Disabled (authoritative-only)',
		LanOnly: 'LAN clients only',
		Public: 'Public (open resolver — caution)',
	};
	let dnsRecursion: RecursionMode = 'LanOnly';
	let savingDnsRecursion = false;
	let dnsRecursionSuccess = false;
	let dnsRecursionError = '';

	// ── DNS Recursion Diagnose ────────────────────────────────────────────────
	type UntrustedClient = { ip: string; rdns: string | null; hits: number; in_acl: boolean };
	type DiagnoseResult = {
		recursion_working: boolean;
		current_mode: RecursionMode;
		current_acl: string[];
		untrusted_clients: UntrustedClient[];
	};
	let diagnosing = false;
	let diagnoseResult: DiagnoseResult | null = null;
	let diagnoseError = '';
	let showDiagnoseModal = false;
	let trustingIp: string | null = null;

	// Toast state
	let toastMessage = '';
	let toastVisible = false;
	let toastTimer: ReturnType<typeof setTimeout> | null = null;

	function showToast(msg: string) {
		toastMessage = msg;
		toastVisible = true;
		if (toastTimer !== null) clearTimeout(toastTimer);
		toastTimer = setTimeout(() => { toastVisible = false; }, 4000);
	}

	async function onDiagnoseClick() {
		diagnosing = true;
		diagnoseError = '';
		diagnoseResult = null;
		try {
			const res = await fetch('/api/config/dns-recursion-diagnose', {
				credentials: 'include',
			});
			if (!res.ok) {
				const body = await res.json().catch(() => ({})) as { error?: string };
				throw new Error(body.error ?? `HTTP ${res.status}`);
			}
			diagnoseResult = (await res.json()) as DiagnoseResult;
			showDiagnoseModal = true;
		} catch (err) {
			diagnoseError = (err as Error).message;
		} finally {
			diagnosing = false;
		}
	}

	async function onTrustClient(ip: string) {
		trustingIp = ip;
		try {
			const res = await fetch('/api/config/dns-recursion-trust', {
				method: 'POST',
				credentials: 'include',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ ip }),
			});
			if (!res.ok) {
				const body = await res.json().catch(() => ({})) as { error?: string };
				throw new Error(body.error ?? `HTTP ${res.status}`);
			}
			showToast(`Added ${ip} to ACL`);
			if (diagnoseResult) {
				diagnoseResult = {
					...diagnoseResult,
					untrusted_clients: diagnoseResult.untrusted_clients.filter((c) => c.ip !== ip),
				};
			}
		} catch (err) {
			showToast(`Error: ${(err as Error).message}`);
		} finally {
			trustingIp = null;
		}
	}

	function closeDiagnoseModal() {
		showDiagnoseModal = false;
	}

	function onDiagnoseModalKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape') closeDiagnoseModal();
	}
	let savingDnsProvider = false;
	let dnsProviderError = '';
	let savingCloudflareToken = false;
	let cloudflareTokenError = '';
	let cloudflareTokenSuccess = false;
	let dnsProviderWarning = '';

	// ── Selector ───────────────────────────────────────────────────────────────
	let availableSites: SiteSummary[] = [];
	let availableZones: ZoneSummary[] = [];
	let selectedSites = new Set<string>();
	let selectedZones = new Set<string>();

	// ── Derived ────────────────────────────────────────────────────────────────
	$: allSitesChecked = selectedSites.size === availableSites.length && availableSites.length > 0;
	$: someSitesChecked = selectedSites.size > 0 && selectedSites.size < availableSites.length;
	$: allZonesChecked = selectedZones.size === availableZones.length && availableZones.length > 0;
	$: someZonesChecked = selectedZones.size > 0 && selectedZones.size < availableZones.length;
	$: nothingSelected = selectedSites.size === 0 && selectedZones.size === 0;
	$: exportScope = computeExportScope(selectedSites, selectedZones, availableSites, availableZones);

	function computeExportScope(
		sites: Set<string>,
		zones: Set<string>,
		allSites: SiteSummary[],
		allZones: ZoneSummary[]
	): 'full' | 'sites' | 'dns' | 'partial' | 'empty' {
		const hasAllSites = sites.size === allSites.length && allSites.length > 0;
		const hasAllZones = zones.size === allZones.length && allZones.length > 0;
		const hasSomeSites = sites.size > 0;
		const hasSomeZones = zones.size > 0;

		if (hasAllSites && hasAllZones) return 'full';
		if (hasAllSites && !hasSomeZones) return 'sites';
		if (!hasSomeSites && hasAllZones) return 'dns';
		if (!hasSomeSites && !hasSomeZones) return 'empty';
		return 'partial';
	}

	function buildExportParams(): string {
		const hasSites = selectedSites.size > 0;
		const hasZones = selectedZones.size > 0;
		const hasAllSites = selectedSites.size === availableSites.length;
		const hasAllZones = selectedZones.size === availableZones.length;

		if (hasAllSites && hasAllZones) return '';

		const params = new URLSearchParams();

		if (hasAllSites && !hasZones) {
			params.set('sites', 'all');
		} else if (!hasSites && hasAllZones) {
			params.set('zones', 'all');
		} else {
			if (hasSites && !hasAllSites) params.set('sites', [...selectedSites].join(','));
			if (hasAllSites && hasSites) params.set('sites', 'all');
			if (hasZones && !hasAllZones) params.set('zones', [...selectedZones].join(','));
			if (hasAllZones && hasZones) params.set('zones', 'all');
		}

		return params.toString();
	}

	function getExportFilename(scope: typeof exportScope): string {
		const date = new Date().toISOString().slice(0, 10);
		if (scope === 'full') return `hermithost-backup-${date}.json`;
		return `hermithost-${scope}-${date}.json`;
	}

	// ── Mount ──────────────────────────────────────────────────────────────────
	onMount(async () => {
		try {
			const [sitesRes, zonesRes, configRes] = await Promise.all([
				fetch('/api/sites'),
				fetch('/api/dns/zones'),
				fetch('/api/config'),
			]);

			if (sitesRes.ok) {
				const data = await sitesRes.json() as SiteSummary[];
				availableSites = data;
				selectedSites = new Set(data.map((s) => s.name));
			}

			if (zonesRes.ok) {
				const data = await zonesRes.json() as ZoneSummary[];
				availableZones = data;
				selectedZones = new Set(data.map((z) => z.name));
			}

			if (configRes.ok) {
				const cfg = await configRes.json() as {
					ns_hostname?: string;
					ns_server_ip?: string;
					dns_forwarders?: [string, string];
					acme_email?: string;
					coolify_url?: string;
					coolify_status?: 'connected' | 'error' | 'not_configured';
					technitium_url?: string;
					technitium_status?: 'connected' | 'error' | 'not_configured';
					dns_provider?: 'technitium' | 'cloudflare';
					cloudflare_status?: 'connected' | 'disconnected' | 'unconfigured';
					cloudflare_token_set?: boolean;
					network_mode?: 'external' | 'internal';
					dns_recursion?: RecursionMode;
				};
				nsHostname = cfg.ns_hostname ?? '';
				nsServerIp = cfg.ns_server_ip ?? '';
				dnsForwarder1 = cfg.dns_forwarders?.[0] ?? '';
				dnsForwarder2 = cfg.dns_forwarders?.[1] ?? '';
				acmeEmail = cfg.acme_email ?? '';
				coolifyUrl = cfg.coolify_url ?? '';
				coolifyStatus = cfg.coolify_status ?? 'not_configured';
				technitiumUrl = cfg.technitium_url ?? '';
				technitiumStatus = cfg.technitium_status ?? 'not_configured';
				dnsProvider = cfg.dns_provider ?? 'technitium';
				cloudflareStatus = cfg.cloudflare_status ?? 'unconfigured';
				networkMode = cfg.network_mode ?? 'external';
				dnsRecursion = cfg.dns_recursion ?? 'LanOnly';
			}
		} catch {
			// non-fatal; page still renders
		}
	});

	// ── Config save ────────────────────────────────────────────────────────────
	async function saveConfig() {
		savingConfig = true;
		configSaveError = '';
		configSaveSuccess = false;
		try {
			const res = await fetch('/api/config', {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ ns_hostname: nsHostname, ns_server_ip: nsServerIp }),
			});
			if (!res.ok) {
				const body = await res.json().catch(() => ({})) as { error?: string };
				throw new Error(body.error ?? `HTTP ${res.status}`);
			}
			configSaveSuccess = true;
			setTimeout(() => { configSaveSuccess = false; }, 3000);
		} catch (err) {
			configSaveError = (err as Error).message;
		} finally {
			savingConfig = false;
		}
	}

	// ── DNS Provider handlers ──────────────────────────────────────────────────
	async function onDnsProviderChange(event: Event) {
		const select = event.currentTarget as HTMLSelectElement;
		const newProvider = select.value as 'technitium' | 'cloudflare';
		if (newProvider === dnsProvider) return;

		dnsProviderWarning = `DNS provisioning will use ${newProvider === 'cloudflare' ? 'Cloudflare' : 'Technitium'} going forward. Existing zones are not migrated automatically.`;
		savingDnsProvider = true;
		dnsProviderError = '';
		try {
			const res = await fetch('/api/config', {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ dns_provider: newProvider }),
			});
			if (!res.ok) {
				const body = await res.json().catch(() => ({})) as { error?: string };
				throw new Error(body.error ?? `HTTP ${res.status}`);
			}
			dnsProvider = newProvider;
		} catch (err) {
			dnsProviderError = (err as Error).message;
			select.value = dnsProvider; // revert select visually
		} finally {
			savingDnsProvider = false;
		}
	}

	async function saveCloudflareToken() {
		if (!cloudflareTokenInput.trim()) return;
		savingCloudflareToken = true;
		cloudflareTokenError = '';
		cloudflareTokenSuccess = false;
		try {
			const res = await fetch('/api/config', {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ cloudflare_token: cloudflareTokenInput.trim() }),
			});
			if (!res.ok) {
				const body = await res.json().catch(() => ({})) as { error?: string };
				throw new Error(body.error ?? `HTTP ${res.status}`);
			}
			const updated = await res.json().catch(() => ({})) as { cloudflare_status?: 'connected' | 'disconnected' | 'unconfigured' };
			if (updated.cloudflare_status) cloudflareStatus = updated.cloudflare_status;
			cloudflareTokenInput = '';
			cloudflareTokenSuccess = true;
			setTimeout(() => { cloudflareTokenSuccess = false; }, 3000);
		} catch (err) {
			cloudflareTokenError = (err as Error).message;
		} finally {
			savingCloudflareToken = false;
		}
	}

	async function onNetworkModeChange(event: Event) {
		const select = event.currentTarget as HTMLSelectElement;
		const newMode = select.value as 'external' | 'internal';
		if (newMode === networkMode) return;

		networkModeWarning = newMode === 'internal'
			? 'New sites will use .hh addresses and the local CA. Existing sites are not updated automatically.'
			: "Switching to internet mode. New sites will use Let's Encrypt. Existing .hh sites are not updated.";

		savingNetworkMode = true;
		networkModeError = '';
		try {
			const res = await fetch('/api/config', {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ network_mode: newMode }),
			});
			if (!res.ok) {
				const body = await res.json().catch(() => ({})) as { error?: string };
				throw new Error(body.error ?? `HTTP ${res.status}`);
			}
			networkMode = newMode;
		} catch (err) {
			networkModeError = (err as Error).message;
			select.value = networkMode;
		} finally {
			savingNetworkMode = false;
		}
	}

	async function downloadTrustCert() {
		downloadingTrustCert = true;
		try {
			const res = await fetch('/api/config/trust-certificate');
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const blob = await res.blob();
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = 'hermithost-trust.crt';
			a.click();
			URL.revokeObjectURL(url);
		} catch (err) {
			networkModeError = (err as Error).message;
		} finally {
			downloadingTrustCert = false;
		}
	}

	async function saveForwarders() {
		savingForwarders = true;
		forwarderSaveError = '';
		forwarderSaveSuccess = false;
		try {
			const res = await fetch('/api/config', {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ dns_forwarders: [dnsForwarder1.trim(), dnsForwarder2.trim()] }),
			});
			if (!res.ok) {
				const body = await res.json().catch(() => ({})) as { error?: string };
				throw new Error(body.error ?? `HTTP ${res.status}`);
			}
			forwarderSaveSuccess = true;
			setTimeout(() => { forwarderSaveSuccess = false; }, 3000);
		} catch (err) {
			forwarderSaveError = (err as Error).message;
		} finally {
			savingForwarders = false;
		}
	}

	// ── DNS Recursion handler ──────────────────────────────────────────────────
	async function onDnsRecursionChange(event: Event) {
		const select = event.currentTarget as HTMLSelectElement;
		const newMode = select.value as RecursionMode;
		const prevMode = dnsRecursion;
		if (newMode === prevMode) return;

		if (newMode === 'Public') {
			const confirmed = confirm(
				'Open resolvers can be abused for DNS amplification attacks. Only enable on trusted networks. Continue?'
			);
			if (!confirmed) {
				select.value = prevMode;
				return;
			}
		}

		savingDnsRecursion = true;
		dnsRecursionError = '';
		dnsRecursionSuccess = false;
		try {
			const res = await fetch('/api/config', {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ dns_recursion: newMode }),
			});
			if (!res.ok) {
				const body = await res.json().catch(() => ({})) as { error?: string };
				throw new Error(body.error ?? `HTTP ${res.status}`);
			}
			dnsRecursion = newMode;
			dnsRecursionSuccess = true;
			setTimeout(() => { dnsRecursionSuccess = false; }, 3000);
		} catch (err) {
			dnsRecursionError = (err as Error).message;
			select.value = prevMode;
		} finally {
			savingDnsRecursion = false;
		}
	}

	// ── Selector helpers ───────────────────────────────────────────────────────
	function toggleSite(name: string) {
		if (selectedSites.has(name)) selectedSites.delete(name);
		else selectedSites.add(name);
		selectedSites = new Set(selectedSites);
	}

	function toggleAllSites() {
		if (allSitesChecked) selectedSites = new Set();
		else selectedSites = new Set(availableSites.map((s) => s.name));
	}

	function toggleZone(name: string) {
		if (selectedZones.has(name)) selectedZones.delete(name);
		else selectedZones.add(name);
		selectedZones = new Set(selectedZones);
	}

	function toggleAllZones() {
		if (allZonesChecked) selectedZones = new Set();
		else selectedZones = new Set(availableZones.map((z) => z.name));
	}

	// ── Backup export ──────────────────────────────────────────────────────────
	let exporting = false;
	let exportError = '';

	async function downloadBackup() {
		exporting = true;
		exportError = '';
		try {
			const params = buildExportParams();
			const url = params ? `/api/backup?${params}` : '/api/backup';
			const res = await fetch(url);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);

			// Try to read filename from Content-Disposition header
			let filename = getExportFilename(exportScope);
			const disposition = res.headers.get('Content-Disposition');
			if (disposition) {
				const match = disposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
				if (match?.[1]) filename = match[1].replace(/['"]/g, '');
			}

			const blob = await res.blob();
			const objectUrl = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = objectUrl;
			a.download = filename;
			a.click();
			URL.revokeObjectURL(objectUrl);
		} catch (err) {
			exportError = (err as Error).message;
		} finally {
			exporting = false;
		}
	}

	// ── Backup import ──────────────────────────────────────────────────────────
	let fileInput: HTMLInputElement;
	let selectedFiles: FileList | null = null;
	let parsedBackup: unknown = null;
	let validateState: 'idle' | 'validating' | 'done' = 'idle';
	let validationResult: ValidationResult | null = null;
	let validateError = '';

	let importState: 'idle' | 'importing' | 'done' = 'idle';
	let importResult: ImportResult | null = null;
	let importError = '';

	// bind:files is the reliable Svelte way to react to file input changes
	$: if (selectedFiles && selectedFiles.length > 0) {
		handleSelectedFile(selectedFiles[0]);
	}

	function resetImport() {
		parsedBackup = null;
		validateState = 'idle';
		validationResult = null;
		validateError = '';
		importState = 'idle';
		importResult = null;
		importError = '';
		if (fileInput) fileInput.value = '';
		selectedFiles = null;
	}

	async function handleSelectedFile(file: File) {
		parsedBackup = null;
		validateState = 'idle';
		validationResult = null;
		validateError = '';
		importState = 'idle';
		importResult = null;
		importError = '';
		try {
			const text = await file.text();
			parsedBackup = JSON.parse(text);
		} catch {
			validateError = 'Could not parse file as JSON';
			return;
		}
		await validateFile();
	}

	async function validateFile() {
		if (!parsedBackup) return;
		validateState = 'validating';
		validateError = '';
		validationResult = null;
		try {
			const res = await fetch('/api/backup/validate', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(parsedBackup),
			});
			validationResult = await res.json() as ValidationResult;
			validateState = 'done';
		} catch (err) {
			validateError = (err as Error).message;
			validateState = 'idle';
		}
	}

	async function importFile() {
		if (!parsedBackup || !validationResult?.valid) return;
		importState = 'importing';
		importError = '';
		importResult = null;
		try {
			const res = await fetch('/api/backup', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(parsedBackup),
			});
			if (!res.ok) {
				const body = await res.json().catch(() => ({})) as { error?: string };
				throw new Error(body.error ?? `HTTP ${res.status}`);
			}
			importResult = await res.json() as ImportResult;
			importState = 'done';
		} catch (err) {
			importError = (err as Error).message;
			importState = 'idle';
		}
	}
</script>

<div class="page">
	<div class="page-header">
		<h1 class="page-title">Settings</h1>
	</div>

	<!-- ── Server ───────────────────────────────────────────────────────────── -->
	<section class="card" style="margin-bottom: 16px;">
		<div class="card-header">
			<div class="card-title-row">
				<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<rect x="2" y="2" width="20" height="8" rx="2" ry="2"/><rect x="2" y="14" width="20" height="8" rx="2" ry="2"/>
					<line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/>
				</svg>
				<h2 class="card-title">Server</h2>
			</div>
			<p class="card-desc">Core server configuration for this HermitHost instance.</p>
		</div>

		<div class="section">
			<div class="field-row">
				<div class="field-group">
					<label class="field-label" for="ns-hostname">Nameserver Hostname</label>
					<p class="field-hint">Used as the authoritative NS record for all hosted zones.</p>
					<div class="input-row">
						<input
							id="ns-hostname"
							class="text-input"
							type="text"
							placeholder="ns1.example.com"
							bind:value={nsHostname}
						/>
					</div>
				</div>
				<div class="field-group">
					<label class="field-label" for="ns-server-ip">Server IP</label>
					<p class="field-hint">IP address used for DNS A records when provisioning new sites.</p>
					<div class="input-row">
						<input
							id="ns-server-ip"
							class="text-input"
							type="text"
							placeholder="203.0.113.10"
							bind:value={nsServerIp}
						/>
					</div>
					<div class="input-row" style="margin-top: 12px;">
						<button class="btn btn-primary" on:click={saveConfig} disabled={savingConfig}>
							{#if savingConfig}
								<span class="spinner"></span> Saving…
							{:else}
								Save
							{/if}
						</button>
					</div>
					{#if configSaveSuccess}
						<p class="inline-success">Saved successfully.</p>
					{/if}
					{#if configSaveError}
						<p class="error-msg">{configSaveError}</p>
					{/if}
				</div>
			</div>

			{#if acmeEmail}
				<div class="field-group" style="margin-top: 16px;">
					<label class="field-label">ACME Email</label>
					<p class="field-hint">Email registered with Let's Encrypt for certificate notifications.</p>
					<p class="readonly-value">{acmeEmail}</p>
				</div>
			{/if}
		</div>
	</section>

	<!-- ── Integrations ─────────────────────────────────────────────────────── -->
	<section class="card" style="margin-bottom: 16px;">
		<div class="card-header">
			<div class="card-title-row">
				<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
					<path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
				</svg>
				<h2 class="card-title">Integrations</h2>
			</div>
			<p class="card-desc">Status of connected backend services.</p>
		</div>

		<div class="section">
			<div class="integration-row">
				<div class="integration-info">
					<span class="status-dot" class:dot-connected={coolifyStatus === 'connected'} class:dot-error={coolifyStatus === 'error'} class:dot-unconfigured={coolifyStatus === 'not_configured'}></span>
					<span class="integration-name">Coolify</span>
					{#if coolifyUrl}
						<span class="integration-url">{coolifyUrl}</span>
					{/if}
				</div>
				<span class="status-label" class:label-connected={coolifyStatus === 'connected'} class:label-error={coolifyStatus === 'error'} class:label-unconfigured={coolifyStatus === 'not_configured'}>
					{#if coolifyStatus === 'connected'}Connected{:else if coolifyStatus === 'error'}Error{:else}Not configured{/if}
				</span>
			</div>

			<div class="integration-row" style="margin-top: 10px;">
				<div class="integration-info">
					<span class="status-dot" class:dot-connected={technitiumStatus === 'connected'} class:dot-error={technitiumStatus === 'error'} class:dot-unconfigured={technitiumStatus === 'not_configured'}></span>
					<span class="integration-name">Technitium DNS</span>
					{#if technitiumUrl}
						<span class="integration-url">{technitiumUrl}</span>
					{/if}
				</div>
				<div class="integration-right">
					{#if dnsProvider === 'technitium'}
						<span class="provider-badge badge-active">Active</span>
					{/if}
					<span class="status-label" class:label-connected={technitiumStatus === 'connected'} class:label-error={technitiumStatus === 'error'} class:label-unconfigured={technitiumStatus === 'not_configured'}>
						{#if technitiumStatus === 'connected'}Connected{:else if technitiumStatus === 'error'}Error{:else}Not configured{/if}
					</span>
				</div>
			</div>

			<!-- DNS Provider selector -->
			<div class="dns-provider-block" style="margin-top: 16px;">
				<div class="field-group">
					<label class="field-label" for="dns-provider">DNS Provider</label>
					<p class="field-hint">Select which provider handles DNS zone provisioning.</p>
					<div class="input-row">
						<select
							id="dns-provider"
							class="text-input select-input"
							on:change={onDnsProviderChange}
							disabled={savingDnsProvider}
							value={dnsProvider}
						>
							<option value="technitium">Technitium</option>
							<option value="cloudflare">Cloudflare</option>
						</select>
						{#if savingDnsProvider}
							<span class="spinner"></span>
						{/if}
					</div>
					{#if dnsProviderWarning}
						<p class="provider-warning">{dnsProviderWarning}</p>
					{/if}
					{#if dnsProviderError}
						<p class="error-msg">{dnsProviderError}</p>
					{/if}
				</div>
			</div>

			<!-- Cloudflare token — only when cloudflare is active -->
			{#if dnsProvider === 'cloudflare'}
				<div class="integration-row cf-token-row" style="margin-top: 10px; flex-direction: column; align-items: flex-start; gap: 10px;">
					<div class="integration-info" style="width: 100%; justify-content: space-between;">
						<div class="integration-info">
							<span
								class="status-dot"
								class:dot-connected={cloudflareStatus === 'connected'}
								class:dot-error={cloudflareStatus === 'disconnected'}
								class:dot-unconfigured={cloudflareStatus === 'unconfigured'}
							></span>
							<span class="integration-name">Cloudflare</span>
							<span class="provider-badge badge-active">Active</span>
						</div>
						<span
							class="status-label"
							class:label-connected={cloudflareStatus === 'connected'}
							class:label-error={cloudflareStatus === 'disconnected'}
							class:label-unconfigured={cloudflareStatus === 'unconfigured'}
						>
							{#if cloudflareStatus === 'connected'}Connected{:else if cloudflareStatus === 'disconnected'}Disconnected{:else}Unconfigured{/if}
						</span>
					</div>
					<div class="field-group" style="width: 100%;">
						<label class="field-label" for="cf-token">Cloudflare API Token</label>
						<p class="field-hint">Requires Zone:DNS:Edit permission on the target zones.</p>
						<div class="input-row">
							<input
								id="cf-token"
								class="text-input"
								type="password"
								placeholder="••••••••••••••••"
								bind:value={cloudflareTokenInput}
								autocomplete="off"
							/>
							<button
								class="btn btn-primary"
								on:click={saveCloudflareToken}
								disabled={savingCloudflareToken || !cloudflareTokenInput.trim()}
							>
								{#if savingCloudflareToken}
									<span class="spinner"></span> Saving…
								{:else}
									Save
								{/if}
							</button>
						</div>
						{#if cloudflareTokenSuccess}
							<p class="inline-success">Token saved successfully.</p>
						{/if}
						{#if cloudflareTokenError}
							<p class="error-msg">{cloudflareTokenError}</p>
						{/if}
					</div>
				</div>
			{/if}
		</div>
	</section>

	<!-- ── Network Mode ──────────────────────────────────────────────────────── -->
	<section class="card" style="margin-bottom: 16px;">
		<div class="card-header">
			<div class="card-title-row">
				<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<path d="M5 12.55a11 11 0 0 1 14.08 0"/>
					<path d="M1.42 9a16 16 0 0 1 21.16 0"/>
					<path d="M8.53 16.11a6 6 0 0 1 6.95 0"/>
					<line x1="12" y1="20" x2="12.01" y2="20"/>
				</svg>
				<h2 class="card-title">Network Mode</h2>
			</div>
			<p class="card-desc">Run on a private network with local certificates, or connect to the internet with Let's Encrypt.</p>
		</div>
		<div class="section">

			<div class="field-group">
				<label class="field-label" for="network-mode">Mode</label>
				<p class="field-hint">Affects new sites only. Existing sites are not updated automatically.</p>
				<div class="input-row">
					<select
						id="network-mode"
						class="text-input select-input"
						on:change={onNetworkModeChange}
						disabled={savingNetworkMode}
						value={networkMode}
					>
						<option value="external">Internet (Let's Encrypt)</option>
						<option value="internal">Private network (.hh)</option>
					</select>
					{#if savingNetworkMode}
						<span class="spinner"></span>
					{/if}
				</div>
				{#if networkModeWarning}
					<p class="provider-warning">{networkModeWarning}</p>
				{/if}
				{#if networkModeError}
					<p class="error-msg">{networkModeError}</p>
				{/if}
			</div>

			{#if networkMode === 'internal'}
				<div class="field-group" style="margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--border);">
					<label class="field-label">Trust Certificate</label>
					<p class="field-hint">
						Install on every device that needs access to your private sites.
						Browsers won't trust <code>.hh</code> addresses without it.
					</p>
					<div class="input-row" style="margin-top: 8px;">
						<button
							class="btn btn-primary"
							on:click={downloadTrustCert}
							disabled={downloadingTrustCert}
						>
							{#if downloadingTrustCert}
								<span class="spinner"></span> Downloading…
							{:else}
								Download trust certificate
							{/if}
						</button>
						<button
							class="btn btn-ghost"
							on:click={() => { showTrustInstall = !showTrustInstall; }}
						>
							{showTrustInstall ? 'Hide' : 'How to install'}
						</button>
					</div>

					{#if showTrustInstall}
						<div class="trust-install-guide" style="margin-top: 12px;">
							<ul class="install-list">
								<li><strong>Mac:</strong> Double-click the .crt file → Keychain Access → right-click → Get Info → Trust → Always Trust</li>
								<li><strong>Windows:</strong> Double-click → Install Certificate → Local Machine → Trusted Root Certification Authorities</li>
								<li><strong>iPhone / iPad:</strong> AirDrop or email the file → tap to install profile → Settings → General → VPN &amp; Device Management → trust it</li>
								<li><strong>Android:</strong> Settings → Security → Install from storage → select the .crt file</li>
							</ul>
						</div>
					{/if}

					<div class="hh-chip" style="margin-top: 12px;">
						<span class="tld-badge">.hh</span>
						<span class="chip-text">Sites on this stack get private addresses (e.g. <code>mysite.hh</code>). Only devices on your local network can reach them.</span>
					</div>
				</div>

				<div class="field-group" style="margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--border);">
					<label class="field-label">DNS Forwarders</label>
					<p class="field-hint">Technitium uses these addresses to resolve external domains (e.g. google.com). Without forwarders, only your .hh sites will resolve.</p>
					<div class="field-row" style="margin-top: 8px;">
						<div class="field-group">
							<label class="field-label" for="dns-forwarder-1">Primary</label>
							<input
								id="dns-forwarder-1"
								class="text-input"
								type="text"
								inputmode="decimal"
								placeholder="1.1.1.1"
								bind:value={dnsForwarder1}
							/>
						</div>
						<div class="field-group">
							<label class="field-label" for="dns-forwarder-2">Secondary</label>
							<input
								id="dns-forwarder-2"
								class="text-input"
								type="text"
								inputmode="decimal"
								placeholder="1.0.0.1"
								bind:value={dnsForwarder2}
							/>
						</div>
					</div>
					<div class="input-row" style="margin-top: 12px;">
						<button class="btn btn-primary" on:click={saveForwarders} disabled={savingForwarders}>
							{#if savingForwarders}
								<span class="spinner"></span> Saving…
							{:else}
								Save
							{/if}
						</button>
					</div>
					{#if forwarderSaveSuccess}
						<p class="inline-success">Saved.</p>
					{/if}
					{#if forwarderSaveError}
						<p class="error-msg">{forwarderSaveError}</p>
					{/if}
				</div>

				<!-- DNS Recursion -->
				<div class="field-group" style="margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--border);">
					<label class="field-label" for="dns-recursion">DNS Recursion</label>
					<p class="field-hint">LAN clients only is the safe default. Public exposes this server as an open resolver — only enable on trusted networks.</p>
					<div class="input-row" style="margin-top: 8px;">
						<select
							id="dns-recursion"
							class="text-input select-input"
							on:change={onDnsRecursionChange}
							disabled={savingDnsRecursion}
							value={dnsRecursion}
						>
							<option value="Disabled">Disabled (authoritative-only)</option>
							<option value="LanOnly">LAN clients only</option>
							<option value="Public">Public (open resolver — caution)</option>
						</select>
						{#if savingDnsRecursion}
							<span class="spinner"></span>
						{/if}
						{#if dnsRecursion === 'LanOnly'}
							<button
								class="btn btn-ghost"
								aria-label="Diagnose DNS recursion issues"
								disabled={diagnosing}
								on:click={onDiagnoseClick}
							>
								{#if diagnosing}
									<span class="spinner"></span>
									Diagnosing…
								{:else}
									Diagnose
								{/if}
							</button>
						{/if}
					</div>
					{#if diagnoseError}
						<p class="error-msg">Diagnose failed: {diagnoseError}</p>
					{/if}
					{#if dnsRecursionSuccess}
						<p class="inline-success">DNS recursion updated to {recursionLabels[dnsRecursion]}.</p>
					{/if}
					{#if dnsRecursionError}
						<p class="error-msg">Failed to update DNS recursion: {dnsRecursionError}</p>
					{/if}
				</div>
			{/if}

		</div>
	</section>

	<!-- ── Backup & Restore ──────────────────────────────────────────────────── -->
	<section class="card">
		<div class="card-header">
			<div class="card-title-row">
				<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<polyline points="20 6 9 17 4 12"/>
				</svg>
				<h2 class="card-title">Backup &amp; Restore</h2>
			</div>
			<p class="card-desc">Export site configuration and DNS zones to a portable JSON file. Restore on a fresh stack.</p>
		</div>

		<!-- Export -->
		<div class="section">
			<h3 class="section-title">Export</h3>
			<p class="section-desc">Select which sites and DNS zones to include. PAT tokens are included — treat the file as sensitive.</p>

			<!-- Sites selector -->
			<div class="selector-block">
				<div class="selector-header">
					<span class="selector-group-label">Sites</span>
					<label class="check-label">
						<input
							type="checkbox"
							checked={allSitesChecked}
							indeterminate={someSitesChecked}
							on:change={toggleAllSites}
						/>
						All
					</label>
				</div>

				{#if availableSites.length === 0}
					<p class="empty-hint">No sites found.</p>
				{:else}
					<ul class="selector-list">
						{#each availableSites as site}
							<li class="selector-item">
								<label class="check-label">
									<input
										type="checkbox"
										checked={selectedSites.has(site.name)}
										on:change={() => toggleSite(site.name)}
									/>
									<span class="item-name">{site.name}</span>
								</label>
								<span class="item-meta">{site.domain}</span>
							</li>
						{/each}
					</ul>
				{/if}
			</div>

			<!-- DNS Zones selector -->
			<div class="selector-block" style="margin-top: 14px;">
				<div class="selector-header">
					<span class="selector-group-label">DNS Zones</span>
					<label class="check-label">
						<input
							type="checkbox"
							checked={allZonesChecked}
							indeterminate={someZonesChecked}
							on:change={toggleAllZones}
						/>
						All
					</label>
				</div>

				{#if availableZones.length === 0}
					<p class="empty-hint">No DNS zones found.</p>
				{:else}
					<ul class="selector-list">
						{#each availableZones as zone}
							<li class="selector-item">
								<label class="check-label">
									<input
										type="checkbox"
										checked={selectedZones.has(zone.name)}
										on:change={() => toggleZone(zone.name)}
									/>
									<span class="item-name">{zone.name}</span>
								</label>
							</li>
						{/each}
					</ul>
				{/if}
			</div>

			<!-- Status line + download -->
			<div class="export-footer">
				{#if !nothingSelected}
					<p class="export-preview">
						{selectedSites.size} site{selectedSites.size !== 1 ? 's' : ''},
						{selectedZones.size} zone{selectedZones.size !== 1 ? 's' : ''}
						&nbsp;&rarr;&nbsp;
						<span class="export-filename">{getExportFilename(exportScope)}</span>
					</p>
				{/if}
				<button
					class="btn btn-primary"
					on:click={downloadBackup}
					disabled={exporting || nothingSelected}
				>
					{#if exporting}
						<span class="spinner"></span> Exporting…
					{:else}
						<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
							<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
							<polyline points="7 10 12 15 17 10"/>
							<line x1="12" y1="15" x2="12" y2="3"/>
						</svg>
						Download Backup
					{/if}
				</button>
				{#if exportError}
					<p class="error-msg">{exportError}</p>
				{/if}
			</div>
		</div>

		<div class="divider"></div>

		<!-- Import -->
		<div class="section">
			<h3 class="section-title">Restore</h3>
			<p class="section-desc">Select a backup file. It will be validated before import is enabled. Existing sites and DNS zones are skipped, not overwritten.</p>

			<label class="file-label">
				<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
				Choose backup file
				<input
					type="file"
					accept=".json,application/json"
					bind:this={fileInput}
					bind:files={selectedFiles}
					class="file-input-hidden"
				/>
			</label>

			{#if validateError}
				<p class="error-msg">{validateError}</p>
			{/if}

			{#if validateState === 'validating'}
				<div class="status-row">
					<span class="spinner"></span>
					<span class="status-text">Validating…</span>
				</div>
			{/if}

			{#if validationResult}
				<div class="validation-card" class:valid={validationResult.valid} class:invalid={!validationResult.valid}>
					<div class="validation-header">
						{#if validationResult.valid}
							<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>
							<span class="valid-label">Valid backup</span>
						{:else}
							<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
							<span class="invalid-label">Invalid backup</span>
						{/if}
					</div>

					<div class="summary-row">
						<span class="summary-chip">{validationResult.summary.sites} site{validationResult.summary.sites !== 1 ? 's' : ''}</span>
						<span class="summary-chip">{validationResult.summary.dns_zones} zone{validationResult.summary.dns_zones !== 1 ? 's' : ''}</span>
						<span class="summary-chip">{validationResult.summary.dns_records} record{validationResult.summary.dns_records !== 1 ? 's' : ''}</span>
					</div>

					{#if validationResult.errors.length}
						<ul class="msg-list error-list">
							{#each validationResult.errors as err}
								<li>{err}</li>
							{/each}
						</ul>
					{/if}

					{#if validationResult.warnings.length}
						<ul class="msg-list warn-list">
							{#each validationResult.warnings as w}
								<li>{w}</li>
							{/each}
						</ul>
					{/if}
				</div>

				{#if validationResult.valid && importState !== 'done'}
					<button
						class="btn btn-danger"
						on:click={importFile}
						disabled={importState === 'importing' || validateState !== 'done'}
					>
						{#if importState === 'importing'}
							<span class="spinner"></span> Importing…
						{:else}
							<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
							Import Backup
						{/if}
					</button>
				{/if}

				{#if importError}
					<p class="error-msg">{importError}</p>
				{/if}
			{/if}

			{#if importResult}
				<div class="import-result">
					<div class="result-section">
						<span class="result-label">Sites</span>
						{#if importResult.sites.created.length}
							<ul class="result-list created">
								{#each importResult.sites.created as s}<li>✓ {s}</li>{/each}
							</ul>
						{/if}
						{#if importResult.sites.skipped.length}
							<ul class="result-list skipped">
								{#each importResult.sites.skipped as s}<li>— {s} (skipped)</li>{/each}
							</ul>
						{/if}
						{#if importResult.sites.failed.length}
							<ul class="result-list failed">
								{#each importResult.sites.failed as s}<li>✗ {s}</li>{/each}
							</ul>
						{/if}
					</div>
					<div class="result-section">
						<span class="result-label">DNS</span>
						{#if importResult.dns.created.length}
							<ul class="result-list created">
								{#each importResult.dns.created as d}<li>✓ {d}</li>{/each}
							</ul>
						{/if}
						{#if importResult.dns.skipped.length}
							<ul class="result-list skipped">
								{#each importResult.dns.skipped as d}<li>— {d} (skipped)</li>{/each}
							</ul>
						{/if}
						{#if importResult.dns.failed.length}
							<ul class="result-list failed">
								{#each importResult.dns.failed as d}<li>✗ {d}</li>{/each}
							</ul>
						{/if}
					</div>
					<button class="btn btn-ghost" on:click={resetImport}>Reset</button>
				</div>
			{/if}
		</div>
	</section>
</div>

<!-- ── DNS Recursion Diagnose Modal ──────────────────────────────────────── -->
{#if showDiagnoseModal && diagnoseResult}
	<!-- svelte-ignore a11y-no-noninteractive-element-interactions -->
	<div
		class="diag-backdrop"
		role="dialog"
		aria-modal="true"
		aria-label="DNS Recursion Diagnosis"
		on:keydown={onDiagnoseModalKeydown}
		tabindex="-1"
	>
		<div class="diag-modal">
			<div class="diag-header">
				<span class="diag-title">
					{#if !diagnoseResult.recursion_working && diagnoseResult.untrusted_clients.length > 0}
						Recursion broken — these clients are being REFUSED
					{:else if diagnoseResult.untrusted_clients.length > 0}
						Some clients refused — review below
					{:else}
						&#10003; Recursion working
					{/if}
				</span>
				<button class="diag-close btn btn-ghost" aria-label="Close" on:click={closeDiagnoseModal}>✕</button>
			</div>
			<div class="diag-body">
				{#if diagnoseResult.untrusted_clients.length === 0}
					<p class="diag-ok-msg">&#10003; Recursion working. No refused clients in last hour.</p>
				{:else}
					<table class="diag-table">
						<thead>
							<tr>
								<th>IP</th>
								<th>Hits (last hour)</th>
								<th></th>
							</tr>
						</thead>
						<tbody>
							{#each diagnoseResult.untrusted_clients as client (client.ip)}
								<tr>
									<td class="diag-ip">
									{client.ip}
									{#if client.rdns}
										<div class="diag-rdns">{client.rdns}</div>
									{:else}
										<div class="diag-rdns diag-rdns--none"><em>(no PTR)</em></div>
									{/if}
								</td>
									<td class="diag-hits">{client.hits}</td>
									<td>
										<button
											class="btn btn-primary diag-trust-btn"
											disabled={trustingIp === client.ip}
											on:click={() => onTrustClient(client.ip)}
										>
											{#if trustingIp === client.ip}
												<span class="spinner"></span>
											{/if}
											Trust this client
										</button>
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				{/if}
			</div>
			<div class="diag-footer">
				<button class="btn btn-ghost" on:click={closeDiagnoseModal}>Dismiss</button>
			</div>
		</div>
	</div>
{/if}

<!-- ── Toast ─────────────────────────────────────────────────────────────── -->
{#if toastVisible}
	<div class="diag-toast" role="status" aria-live="polite">{toastMessage}</div>
{/if}

<style>
	.page {
		padding: 32px;
		max-width: 680px;
	}

	.page-header {
		margin-bottom: 28px;
	}

	.page-title {
		font-size: 20px;
		font-weight: 600;
		color: var(--text-primary);
		margin: 0;
	}

	.card {
		background: var(--bg-surface);
		border: 1px solid var(--border);
		border-radius: 8px;
		overflow: hidden;
	}

	.card-header {
		padding: 20px 24px 16px;
		border-bottom: 1px solid var(--border);
	}

	.card-title-row {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-bottom: 6px;
		color: var(--accent-teal);
	}

	.card-title {
		font-size: 14px;
		font-weight: 600;
		color: var(--text-primary);
		margin: 0;
	}

	.card-desc {
		font-size: 12px;
		color: var(--text-muted);
		margin: 0;
		line-height: 1.5;
	}

	.section {
		padding: 20px 24px;
	}

	.section-title {
		font-size: 12px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--text-muted);
		margin: 0 0 6px;
	}

	.section-desc {
		font-size: 12px;
		color: var(--text-secondary);
		margin: 0 0 14px;
		line-height: 1.5;
	}

	.divider {
		height: 1px;
		background: var(--border);
	}

	/* ── Form fields ── */
	.field-group {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.field-row {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.field-label {
		font-size: 12px;
		font-weight: 600;
		color: var(--text-secondary);
	}

	.field-hint {
		font-size: 11px;
		color: var(--text-muted);
		line-height: 1.4;
	}

	.input-row {
		display: flex;
		gap: 8px;
		align-items: center;
		margin-top: 4px;
	}

	.text-input {
		flex: 1;
		background: var(--bg-elevated);
		border: 1px solid var(--border);
		border-radius: 5px;
		padding: 7px 10px;
		font-size: 12px;
		font-family: var(--font-mono);
		color: var(--text-primary);
		outline: none;
		transition: border-color 0.15s;
	}

	.text-input:focus {
		border-color: var(--accent-teal);
	}

	.text-input::placeholder {
		color: var(--text-muted);
	}

	.readonly-value {
		font-size: 12px;
		font-family: var(--font-mono);
		color: var(--text-secondary);
		background: var(--bg-elevated);
		border: 1px solid var(--border);
		border-radius: 5px;
		padding: 7px 10px;
		margin-top: 4px;
	}

	.inline-success {
		font-size: 12px;
		color: var(--success, #4caf82);
		margin-top: 6px;
	}

	/* ── Integrations ── */
	.integration-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 10px 12px;
		background: var(--bg-elevated);
		border: 1px solid var(--border);
		border-radius: 6px;
	}

	.integration-info {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.status-dot {
		display: inline-block;
		width: 8px;
		height: 8px;
		border-radius: 50%;
		flex-shrink: 0;
	}

	.dot-connected { background: var(--success, #4caf82); }
	.dot-error { background: var(--danger, #cf5c5c); }
	.dot-unconfigured { background: var(--text-muted, #4a5568); }

	.integration-name {
		font-size: 12px;
		font-weight: 500;
		color: var(--text-primary);
	}

	.integration-url {
		font-size: 11px;
		font-family: var(--font-mono);
		color: var(--text-muted);
	}

	.status-label {
		font-size: 11px;
		font-weight: 500;
	}

	.label-connected { color: var(--success, #4caf82); }
	.label-error { color: var(--danger, #cf5c5c); }
	.label-unconfigured { color: var(--text-muted, #4a5568); }

	/* ── Selector ── */
	.selector-block {
		border: 1px solid var(--border);
		border-radius: 6px;
		overflow: hidden;
	}

	.selector-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 8px 12px;
		background: var(--bg-elevated);
		border-bottom: 1px solid var(--border);
	}

	.selector-group-label {
		font-size: 11px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--text-muted);
	}

	.selector-list {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.selector-item {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 7px 12px;
		border-bottom: 1px solid var(--border);
	}

	.selector-item:last-child {
		border-bottom: none;
	}

	.check-label {
		display: inline-flex;
		align-items: center;
		gap: 7px;
		font-size: 12px;
		color: var(--text-secondary);
		cursor: pointer;
		user-select: none;
	}

	.check-label input[type='checkbox'] {
		accent-color: var(--accent-teal);
		width: 13px;
		height: 13px;
		cursor: pointer;
	}

	.item-name {
		font-family: var(--font-mono);
		font-size: 12px;
		color: var(--text-primary);
	}

	.item-meta {
		font-size: 11px;
		font-family: var(--font-mono);
		color: var(--text-muted);
	}

	.empty-hint {
		font-size: 12px;
		color: var(--text-muted);
		padding: 10px 12px;
	}

	/* ── Export footer ── */
	.export-footer {
		margin-top: 14px;
		display: flex;
		flex-direction: column;
		gap: 8px;
		align-items: flex-start;
	}

	.export-preview {
		font-size: 12px;
		color: var(--text-secondary);
	}

	.export-filename {
		font-family: var(--font-mono);
		color: var(--accent-teal);
	}

	/* ── Buttons ── */
	.btn {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 7px 14px;
		border-radius: 5px;
		font-size: 12px;
		font-weight: 500;
		cursor: pointer;
		border: none;
		transition: background 0.1s, opacity 0.1s;
	}

	.btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.btn-primary {
		background: var(--accent-teal);
		color: #000;
	}

	.btn-primary:hover:not(:disabled) {
		filter: brightness(1.1);
	}

	.btn-danger {
		background: var(--danger, #cf5c5c);
		color: #fff;
	}

	.btn-danger:hover:not(:disabled) {
		filter: brightness(1.1);
	}

	.btn-ghost {
		background: var(--bg-elevated);
		color: var(--text-secondary);
		border: 1px solid var(--border);
	}

	.btn-ghost:hover:not(:disabled) {
		background: var(--bg-hover);
		color: var(--text-primary);
	}

	/* ── File picker ── */
	.file-label {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 7px 14px;
		border-radius: 5px;
		font-size: 12px;
		font-weight: 500;
		cursor: pointer;
		background: var(--bg-elevated);
		color: var(--text-secondary);
		border: 1px solid var(--border);
		transition: background 0.1s, color 0.1s;
		margin-bottom: 12px;
	}

	.file-label:hover {
		background: var(--bg-hover);
		color: var(--text-primary);
	}

	.file-input-hidden {
		display: none;
	}

	/* ── Spinner ── */
	.spinner {
		display: inline-block;
		width: 12px;
		height: 12px;
		border: 2px solid currentColor;
		border-top-color: transparent;
		border-radius: 50%;
		animation: spin 0.6s linear infinite;
	}

	@keyframes spin {
		to { transform: rotate(360deg); }
	}

	/* ── Status / feedback ── */
	.status-row {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 12px;
		color: var(--text-muted);
		margin-bottom: 12px;
	}

	.status-text {
		color: var(--text-muted);
	}

	.error-msg {
		font-size: 12px;
		color: var(--danger, #cf5c5c);
		margin: 8px 0 0;
	}

	/* ── Validation card ── */
	.validation-card {
		border: 1px solid var(--border);
		border-radius: 6px;
		padding: 14px 16px;
		margin: 12px 0;
	}

	.validation-card.valid {
		border-color: var(--success, #4caf82);
		background: color-mix(in srgb, var(--success, #4caf82) 8%, transparent);
	}

	.validation-card.invalid {
		border-color: var(--danger, #cf5c5c);
		background: color-mix(in srgb, var(--danger, #cf5c5c) 8%, transparent);
	}

	.validation-header {
		display: flex;
		align-items: center;
		gap: 6px;
		margin-bottom: 10px;
		font-size: 13px;
		font-weight: 600;
	}

	.valid-label { color: var(--success, #4caf82); }
	.invalid-label { color: var(--danger, #cf5c5c); }

	.summary-row {
		display: flex;
		gap: 6px;
		flex-wrap: wrap;
		margin-bottom: 10px;
	}

	.summary-chip {
		font-family: var(--font-mono);
		font-size: 11px;
		padding: 2px 8px;
		background: var(--bg-elevated);
		border: 1px solid var(--border);
		border-radius: 3px;
		color: var(--text-secondary);
	}

	.msg-list {
		margin: 6px 0;
		padding-left: 16px;
		font-size: 12px;
		line-height: 1.6;
	}

	.error-list { color: var(--danger, #cf5c5c); }
	.warn-list { color: var(--warning, #d4a843); }

	/* ── Import result ── */
	.import-result {
		margin-top: 14px;
		border: 1px solid var(--border);
		border-radius: 6px;
		padding: 14px 16px;
	}

	.result-section {
		margin-bottom: 12px;
	}

	.result-label {
		font-size: 11px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--text-muted);
		display: block;
		margin-bottom: 4px;
	}

	.result-list {
		margin: 0;
		padding-left: 16px;
		font-size: 12px;
		font-family: var(--font-mono);
		line-height: 1.7;
	}

	.result-list.created { color: var(--success, #4caf82); }
	.result-list.skipped { color: var(--text-muted); }
	.result-list.failed { color: var(--danger, #cf5c5c); }

	/* ── DNS Provider ── */
	.select-input {
		appearance: none;
		background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%234a5568' stroke-width='2'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E");
		background-repeat: no-repeat;
		background-position: right 10px center;
		padding-right: 28px;
		cursor: pointer;
	}

	.dns-provider-block {
		padding: 0;
	}

	.integration-right {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.provider-badge {
		font-size: 10px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		padding: 2px 6px;
		border-radius: 3px;
	}

	.badge-active {
		background: color-mix(in srgb, var(--accent-teal) 15%, transparent);
		color: var(--accent-teal);
		border: 1px solid color-mix(in srgb, var(--accent-teal) 35%, transparent);
	}

	.provider-warning {
		font-size: 11px;
		color: var(--warning, #d4a843);
		margin-top: 6px;
		line-height: 1.4;
		padding: 6px 10px;
		background: color-mix(in srgb, var(--warning, #d4a843) 10%, transparent);
		border: 1px solid color-mix(in srgb, var(--warning, #d4a843) 30%, transparent);
		border-radius: 4px;
	}

	.cf-token-row {
		padding: 12px;
	}

	/* ── Trust cert install guide ───────────────────────────────── */
	.install-list {
		margin: 0;
		padding-left: 18px;
		display: flex;
		flex-direction: column;
		gap: 6px;
		font-size: 13px;
		color: var(--text-muted);
		line-height: 1.5;
	}

	/* ── .hh chip ───────────────────────────────────────────────── */
	.hh-chip {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		padding: 10px 12px;
		background: var(--bg-elevated);
		border: 1px solid var(--border);
		border-radius: 6px;
		font-size: 13px;
	}

	.tld-badge {
		font-family: monospace;
		font-size: 12px;
		font-weight: 600;
		background: var(--accent-teal);
		color: #fff;
		padding: 2px 6px;
		border-radius: 4px;
		white-space: nowrap;
		flex-shrink: 0;
	}

	.chip-text {
		color: var(--text-muted);
		line-height: 1.5;
	}

	/* ── DNS Diagnose Modal ── */
	.diag-backdrop {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.55);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 1000;
	}

	.diag-modal {
		background: var(--bg-surface);
		border: 1px solid var(--border);
		border-radius: 8px;
		width: min(560px, 92vw);
		display: flex;
		flex-direction: column;
		max-height: 80vh;
		overflow: hidden;
	}

	.diag-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 14px 16px;
		border-bottom: 1px solid var(--border);
	}

	.diag-title {
		font-size: 13px;
		font-weight: 600;
		color: var(--text-primary);
	}

	.diag-close {
		padding: 4px 8px;
		font-size: 13px;
	}

	.diag-body {
		padding: 16px;
		overflow-y: auto;
		flex: 1;
	}

	.diag-ok-msg {
		font-size: 13px;
		color: var(--success, #4caf82);
		margin: 0;
	}

	.diag-table {
		width: 100%;
		border-collapse: collapse;
		font-size: 12px;
	}

	.diag-table th {
		text-align: left;
		color: var(--text-muted);
		font-weight: 500;
		padding: 6px 8px;
		border-bottom: 1px solid var(--border);
	}

	.diag-table td {
		padding: 8px;
		border-bottom: 1px solid var(--border);
		vertical-align: middle;
	}

	.diag-ip {
		font-family: var(--font-mono);
		color: var(--text-primary);
	}

	.diag-rdns {
		font-family: var(--font-mono);
		font-size: 0.78em;
		color: var(--text-secondary);
		margin-top: 2px;
	}

	.diag-rdns--none {
		color: var(--text-tertiary, var(--text-secondary));
	}

	.diag-hits {
		color: var(--text-secondary);
	}

	.diag-trust-btn {
		padding: 5px 10px;
		font-size: 11px;
	}

	.diag-footer {
		padding: 12px 16px;
		border-top: 1px solid var(--border);
		display: flex;
		justify-content: flex-end;
	}

	/* ── Toast ── */
	.diag-toast {
		position: fixed;
		bottom: 24px;
		right: 24px;
		background: var(--bg-elevated);
		border: 1px solid var(--border);
		border-radius: 6px;
		padding: 10px 16px;
		font-size: 12px;
		color: var(--text-primary);
		z-index: 1100;
		box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
		pointer-events: none;
	}
</style>
