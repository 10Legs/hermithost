import { browser } from '$app/environment';
import { goto } from '$app/navigation';
import type { LayoutLoad } from './$types';

export const ssr = false;

export const load: LayoutLoad = async ({ url, fetch }) => {
	if (!browser) return {};

	const isLoginPage = url.pathname.startsWith('/login');

	try {
		const res = await fetch('/api/auth/check', { credentials: 'same-origin' });

		if (res.ok) {
			// Authenticated — redirect away from login page
			if (isLoginPage) {
				await goto('/');
			}
		} else {
			// Not authenticated — redirect to login (unless already there)
			if (!isLoginPage) {
				await goto('/login');
			}
		}
	} catch {
		// Network error: fail open to avoid locking out the user entirely
		// The API endpoints themselves will enforce auth server-side
		if (!isLoginPage) {
			await goto('/login');
		}
	}

	return {};
};
