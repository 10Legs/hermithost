<script lang="ts">
	import { goto } from '$app/navigation';

	let password = '';
	let loading = false;
	let error = '';

	async function handleSubmit(e: SubmitEvent) {
		e.preventDefault();
		if (loading) return;
		loading = true;
		error = '';

		try {
			const res = await fetch('/api/auth/login', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ password }),
				credentials: 'same-origin'
			});

			if (res.ok) {
				await goto('/');
			} else {
				error = 'Invalid password';
				password = '';
			}
		} catch {
			error = 'Connection error. Please try again.';
		} finally {
			loading = false;
		}
	}
</script>

<svelte:head>
	<title>Sign In — HermitHost</title>
</svelte:head>

<div class="login-shell">
	<div class="login-card">
		<div class="login-header">
			<span class="logo-icon">⬡</span>
			<span class="logo-text">HermitHost</span>
		</div>

		<form on:submit={handleSubmit} class="login-form" novalidate>
			<div class="field">
				<label for="password">Password</label>
				<input
					id="password"
					type="password"
					bind:value={password}
					placeholder="Enter admin password"
					autocomplete="current-password"
					autofocus
					disabled={loading}
					required
				/>
			</div>

			{#if error}
				<p class="error-msg" role="alert">{error}</p>
			{/if}

			<button type="submit" class="btn-primary" disabled={loading || !password}>
				{#if loading}
					<span class="spinner" aria-hidden="true"></span>
					Signing in…
				{:else}
					Sign In
				{/if}
			</button>
		</form>
	</div>
</div>

<style>
	.login-shell {
		display: flex;
		align-items: center;
		justify-content: center;
		min-height: 100vh;
		background: var(--bg);
		padding: 24px;
	}

	.login-card {
		width: 100%;
		max-width: 340px;
		background: var(--bg-surface);
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 32px 28px;
	}

	.login-header {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 16px;
		font-weight: 600;
		color: var(--text-primary);
		margin-bottom: 28px;
	}

	.logo-icon {
		color: var(--accent-teal);
		font-size: 20px;
	}

	.login-form {
		display: flex;
		flex-direction: column;
		gap: 16px;
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	label {
		font-size: 11px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--text-secondary);
	}

	input[type='password'] {
		background: var(--bg-elevated);
		border: 1px solid var(--border-bright);
		border-radius: 5px;
		color: var(--text-primary);
		font-family: var(--font-ui);
		font-size: 14px;
		padding: 9px 12px;
		width: 100%;
		outline: none;
		transition: border-color 0.15s;
	}

	input[type='password']:focus {
		border-color: var(--accent-teal);
	}

	input[type='password']:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.error-msg {
		font-size: 12px;
		color: var(--danger);
		background: color-mix(in srgb, var(--danger) 10%, transparent);
		border: 1px solid color-mix(in srgb, var(--danger) 30%, transparent);
		border-radius: 4px;
		padding: 8px 10px;
		margin: 0;
	}

	.btn-primary {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
		background: var(--accent-teal);
		color: #fff;
		border: none;
		border-radius: 5px;
		font-size: 13px;
		font-weight: 500;
		padding: 9px 16px;
		width: 100%;
		transition: background 0.15s, opacity 0.15s;
	}

	.btn-primary:hover:not(:disabled) {
		background: var(--accent-teal-dim);
	}

	.btn-primary:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	@keyframes spin {
		to { transform: rotate(360deg); }
	}

	.spinner {
		width: 12px;
		height: 12px;
		border: 2px solid rgba(255, 255, 255, 0.3);
		border-top-color: #fff;
		border-radius: 50%;
		animation: spin 0.7s linear infinite;
		flex-shrink: 0;
	}

	@media (prefers-reduced-motion: reduce) {
		.spinner {
			animation: none;
			opacity: 0.6;
		}
	}
</style>
