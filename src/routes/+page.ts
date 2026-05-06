import type { PageLoad } from './$types';
import type { Site } from '$lib/types';

export const ssr = false;

export const load: PageLoad = async ({ fetch }) => {
	const res = await fetch('/api/sites');
	if (!res.ok) {
		throw new Error(`Failed to load sites: ${res.status}`);
	}
	const sites: Site[] = await res.json();
	return { sites };
};
