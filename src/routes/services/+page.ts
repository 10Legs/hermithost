import type { PageLoad } from './$types';
import type { ServicesResponse } from '$lib/types';

export const ssr = false;

export const load: PageLoad = async ({ fetch }) => {
	const res = await fetch('/api/services');
	if (!res.ok) throw new Error(`Failed to load services: ${res.status}`);
	const services: ServicesResponse = await res.json();
	return { services };
};
