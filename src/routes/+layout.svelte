<script lang="ts">
	import '../app.css';
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';

	async function handleLogout() {
		try {
			await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
		} finally {
			await goto('/login');
		}
	}
</script>

{#if $page.url.pathname !== '/login'}
<div class="app-shell">
	<nav class="sidebar">
		<div class="sidebar-header">
			<div class="logo">
				<span class="logo-icon">⬡</span>
				<span class="logo-text">HermitHost</span>
			</div>
			<div class="logo-sub">v0.2.0 <span class="logo-commit">· {__GIT_COMMIT__}</span></div>
		</div>

		<div class="nav-section">
			<div class="nav-label">Management</div>
			<a href="/" class="nav-item" class:active={$page.url.pathname === '/'}>
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
				Sites
			</a>
			<a href="/dns" class="nav-item" class:active={$page.url.pathname.startsWith('/dns')}>
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>
				DNS
			</a>
		</div>

		<div class="nav-section">
			<div class="nav-label">Configuration</div>
			<a href="/settings" class="nav-item" class:active={$page.url.pathname.startsWith('/settings')}>
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M4.93 4.93a10 10 0 0 0 0 14.14"/></svg>
				Settings
			</a>
		</div>

		<div class="nav-section">
			<div class="nav-label">System</div>
			<span class="nav-item nav-disabled">
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
				Health
				<span class="badge-soon">soon</span>
			</span>
			<a href="/services" class="nav-item" class:active={$page.url.pathname.startsWith('/services')}>
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="4" rx="1"/><rect x="2" y="10" width="20" height="4" rx="1"/><rect x="2" y="17" width="20" height="4" rx="1"/></svg>
				Services
			</a>
		</div>

		<div class="sidebar-footer">
			<div class="server-indicator">
				<span class="dot dot-success"></span>
				<span>vps-01</span>
			</div>
			<div class="server-indicator">
				<span class="dot dot-success"></span>
				<span>vps-02</span>
			</div>
			<button class="logout-btn" on:click={handleLogout} aria-label="Sign out">
				<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
				Sign Out
			</button>
		</div>
	</nav>

	<main class="main-content">
		<slot />
	</main>
</div>
{:else}
	<slot />
{/if}

<style>
	.app-shell {
		display: flex;
		min-height: 100vh;
	}

	.sidebar {
		width: 220px;
		min-width: 220px;
		background: var(--bg-surface);
		border-right: 1px solid var(--border);
		display: flex;
		flex-direction: column;
		position: fixed;
		top: 0;
		left: 0;
		bottom: 0;
		overflow-y: auto;
	}

	.sidebar-header {
		padding: 20px 16px 16px;
		border-bottom: 1px solid var(--border);
	}

	.logo {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 15px;
		font-weight: 600;
		color: var(--text-primary);
		margin-bottom: 4px;
	}

	.logo-icon {
		color: var(--accent-teal);
		font-size: 18px;
	}

	.logo-text {
		letter-spacing: -0.01em;
	}

	.logo-sub {
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--text-muted);
		margin-left: 26px;
	}
	.logo-commit {
		opacity: 0.5;
		font-size: 0.85em;
		letter-spacing: 0.03em;
	}

	.nav-section {
		padding: 16px 8px 8px;
	}

	.nav-label {
		font-size: 10px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.1em;
		color: var(--text-muted);
		padding: 0 8px;
		margin-bottom: 4px;
	}

	.nav-item {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 7px 8px;
		border-radius: 5px;
		color: var(--text-secondary);
		font-size: 13px;
		transition: background 0.1s, color 0.1s;
		width: 100%;
	}

	.nav-item:hover {
		background: var(--bg-hover);
		color: var(--text-primary);
	}

	.nav-item.active {
		background: var(--bg-hover);
		color: var(--text-primary);
	}

	.nav-item.active svg {
		color: var(--accent-teal);
	}

	.nav-disabled {
		opacity: 0.4;
		pointer-events: none;
	}

	.badge-soon {
		margin-left: auto;
		font-size: 9px;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		background: var(--bg-elevated);
		color: var(--text-muted);
		padding: 1px 5px;
		border-radius: 3px;
		border: 1px solid var(--border);
	}

	.sidebar-footer {
		margin-top: auto;
		padding: 12px 16px;
		border-top: 1px solid var(--border);
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.server-indicator {
		display: flex;
		align-items: center;
		gap: 7px;
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--text-secondary);
	}

	.dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		flex-shrink: 0;
	}

	.dot-success { background: var(--success); }

	.logout-btn {
		display: flex;
		align-items: center;
		gap: 7px;
		background: none;
		border: none;
		color: var(--text-muted);
		font-size: 11px;
		font-family: var(--font-ui);
		padding: 4px 0;
		margin-top: 4px;
		cursor: pointer;
		transition: color 0.15s;
		width: 100%;
		text-align: left;
	}

	.logout-btn:hover {
		color: var(--danger);
	}

	.main-content {
		margin-left: 220px;
		flex: 1;
		min-width: 0;
		overflow-x: hidden;
	}
</style>
