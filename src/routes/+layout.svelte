<script lang="ts">
	import '../app.css';
	import { page } from '$app/stores';
</script>

<div class="app-shell">
	<nav class="sidebar">
		<div class="sidebar-header">
			<div class="logo">
				<span class="logo-icon">⬡</span>
				<span class="logo-text">HermitHost</span>
			</div>
			<div class="logo-sub">v0.1.0</div>
		</div>

		<div class="nav-section">
			<div class="nav-label">Management</div>
			<a href="/" class="nav-item" class:active={$page.url.pathname === '/'}>
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
				Sites
			</a>
		</div>

		<div class="nav-section">
			<div class="nav-label">System</div>
			<span class="nav-item nav-disabled">
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
				Health
				<span class="badge-soon">soon</span>
			</span>
			<span class="nav-item nav-disabled">
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M4.93 4.93a10 10 0 0 0 0 14.14"/></svg>
				Servers
				<span class="badge-soon">soon</span>
			</span>
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
		</div>
	</nav>

	<main class="main-content">
		<slot />
	</main>
</div>

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

	.main-content {
		margin-left: 220px;
		flex: 1;
		min-width: 0;
		overflow-x: hidden;
	}
</style>
