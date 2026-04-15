import type { PageLoad } from './$types';
import type { Site, DnsRecord, Deploy } from '$lib/types';
import { error } from '@sveltejs/kit';

export const load: PageLoad = async ({ fetch, params }) => {
	const siteRes = await fetch(`/api/sites/${params.slug}`);
	if (siteRes.status === 404) {
		throw error(404, `Site "${params.slug}" not found`);
	}
	if (!siteRes.ok) {
		throw new Error(`Failed to load site: ${siteRes.status}`);
	}
	const site: Site = await siteRes.json();

	const [dnsRes, deploysRes] = await Promise.all([
		fetch(`/api/sites/${params.slug}/dns`),
		fetch(`/api/sites/${params.slug}/deployments`)
	]);

	if (!dnsRes.ok) {
		throw new Error(`Failed to load DNS records: ${dnsRes.status}`);
	}
	if (!deploysRes.ok) {
		throw new Error(`Failed to load deployments: ${deploysRes.status}`);
	}

	const dns: DnsRecord[] = await dnsRes.json();
	const deploys: Deploy[] = await deploysRes.json();

	return { site, dns, deploys };
};
