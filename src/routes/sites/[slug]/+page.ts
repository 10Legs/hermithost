import { getSite } from '$lib/data';
import { error } from '@sveltejs/kit';
import type { PageLoad } from './$types';

export const load: PageLoad = ({ params }) => {
	const site = getSite(params.slug);
	if (!site) {
		throw error(404, `Site "${params.slug}" not found`);
	}
	return { site };
};
