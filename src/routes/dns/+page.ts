import type { PageLoad } from './$types';

export interface DnsZone {
  name: string;
  type: string;
  disabled: boolean;
  internal: boolean;
  dnssecStatus: string;
}

export interface DnsPageData {
  zones: DnsZone[];
  nsHostname: string | null;
}

export const load: PageLoad = async ({ fetch }): Promise<DnsPageData> => {
  const [zonesRes, configRes] = await Promise.all([
    fetch('/api/dns/zones'),
    fetch('/api/dns/config'),
  ]);
  const zones: DnsZone[] = zonesRes.ok ? await zonesRes.json() : [];
  const config = configRes.ok ? await configRes.json() : {};
  return { zones, nsHostname: config.nsHostname ?? null };
};
