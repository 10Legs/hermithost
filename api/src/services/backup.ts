import { readFileSync } from 'fs';
import { createCoolifyClient } from './coolify';
import { createTechnitiumClient } from './technitium';
import { embedPatInRepoUrl, linkGithubKey } from '../routes/sites';
import { readNsHostname } from '../routes/config';

// Basic FQDN pattern — rejects bare hostnames, IPs, and embedded paths.
// Allows subdomains (sub.example.com) and TLDs of 2-24 chars.
const FQDN_RE = /^(?!-)([a-zA-Z0-9-]{1,63}\.)+[a-zA-Z]{2,24}$/;

export interface BackupSite {
  name: string;
  domain: string;
  git_repository: string;
  git_branch: string;
  description: string;
  deploy_auth: 'ssh_key' | 'pat';
  deploy_token?: string;
}

export interface BackupDnsRecord {
  name: string;
  type: string;
  ttl: number;
  rData: Record<string, unknown>;
}

export interface BackupDnsZone {
  name: string;
  type: string;
  records: BackupDnsRecord[];
}

export interface BackupFile {
  version: 1;
  exported_at: string;
  sites: BackupSite[];
  dns_zones: BackupDnsZone[];
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  summary: { sites: number; dns_zones: number; dns_records: number };
}

export interface ImportResult {
  sites: { created: string[]; skipped: string[]; failed: string[] };
  dns: { created: string[]; skipped: string[]; failed: string[] };
}

const KNOWN_RECORD_TYPES = new Set(['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SRV', 'SOA', 'CAA', 'PTR']);

function extractPat(repoUrl: string): { cleanUrl: string; token: string } | null {
  try {
    const url = new URL(repoUrl);
    if (url.username) {
      const token = url.username;
      url.username = '';
      url.password = '';
      return { cleanUrl: url.toString(), token };
    }
  } catch { /* not a valid URL */ }
  return null;
}

// Provision DNS A record for a site domain — tracked version that returns success/failure.
// Non-fatal: failures are returned as a string, never thrown.
async function provisionSiteDns(domain: string): Promise<string | null> {
  const serverIp = readNsHostname();
  if (!serverIp) return 'NS_HOSTNAME not set';

  const bare = domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '').trim();
  if (!bare) return 'empty domain';

  const client = createTechnitiumClient();
  if (!client) return 'Technitium not configured';

  try {
    await client.createZone(bare, 'Primary').catch((err: Error) => {
      if (!err.message.toLowerCase().includes('already exists')) throw err;
    });
    const params = new URLSearchParams();
    params.set('type', 'A');
    params.set('ttl', '3600');
    params.set('ipAddress', serverIp);
    await client.addRecord(bare, params);
    return null; // success
  } catch (err) {
    return (err as Error).message;
  }
}

export interface ExportFilter {
  sites?: string[];   // undefined = all; [] = none; [...names] = subset
  zones?: string[];   // same semantics
}

export async function exportBackup(filter?: ExportFilter): Promise<BackupFile> {
  const coolify = createCoolifyClient();
  const technitium = createTechnitiumClient();

  let sites: BackupSite[] = [];
  if (coolify) {
    const apps = await coolify.listApplications();
    for (const app of apps) {
      const domain = app.fqdn
        ? app.fqdn.split(',')[0].trim().replace(/^https?:\/\//, '')
        : '';
      const patResult = extractPat(app.git_repository);
      if (patResult) {
        sites.push({
          name: app.name,
          domain,
          git_repository: patResult.cleanUrl,
          git_branch: app.git_branch,
          description: app.description ?? '',
          deploy_auth: 'pat',
          deploy_token: patResult.token,
        });
      } else {
        sites.push({
          name: app.name,
          domain,
          git_repository: app.git_repository,
          git_branch: app.git_branch,
          description: app.description ?? '',
          deploy_auth: 'ssh_key',
        });
      }
    }
  }

  // Apply sites filter: undefined = keep all, [] = keep none, [...names] = subset
  if (Array.isArray(filter?.sites)) {
    const allowed = new Set(filter!.sites);
    sites = allowed.size === 0 ? [] : sites.filter(s => allowed.has(s.name));
  }

  const dns_zones: BackupDnsZone[] = [];
  // Skip Technitium calls entirely when zones filter is an empty array
  const skipZones = Array.isArray(filter?.zones) && filter!.zones.length === 0;
  if (technitium && !skipZones) {
    const zones = await technitium.listZones();
    const allowedZones = Array.isArray(filter?.zones) ? new Set(filter!.zones) : null;
    for (const zone of zones.filter(z => !z.internal)) {
      if (allowedZones && !allowedZones.has(zone.name)) continue;
      const result = await technitium.getRecords(zone.name).catch(() => null);
      dns_zones.push({
        name: zone.name,
        type: zone.type,
        records: result?.records.map(r => ({
          name: r.name,
          type: r.type,
          ttl: r.ttl,
          rData: r.rData as Record<string, unknown>,
        })) ?? [],
      });
    }
  }

  return {
    version: 1,
    exported_at: new Date().toISOString(),
    sites,
    dns_zones,
  };
}

export async function validateBackup(data: unknown): Promise<ValidationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const empty = { sites: 0, dns_zones: 0, dns_records: 0 };

  if (typeof data !== 'object' || data === null) {
    return { valid: false, errors: ['Backup must be a JSON object'], warnings: [], summary: empty };
  }

  const b = data as Record<string, unknown>;
  if (b.version !== 1) errors.push('version must be 1');
  if (!Array.isArray(b.sites)) errors.push('sites must be an array');
  if (!Array.isArray(b.dns_zones)) errors.push('dns_zones must be an array');
  if (errors.length) return { valid: false, errors, warnings, summary: empty };

  const sites = b.sites as Record<string, unknown>[];
  const dns_zones = b.dns_zones as Record<string, unknown>[];

  for (let i = 0; i < sites.length; i++) {
    const s = sites[i];
    const p = `sites[${i}]`;
    if (!s.name) errors.push(`${p}: name is required`);
    if (!s.domain) {
      errors.push(`${p}: domain is required`);
    } else {
      // Validate FQDN format — strip protocol first if present
      const bare = (s.domain as string).replace(/^https?:\/\//, '').replace(/\/.*$/, '');
      if (!FQDN_RE.test(bare)) {
        errors.push(`${p}: domain '${bare}' is not a valid FQDN`);
      }
    }
    if (!s.git_repository) errors.push(`${p}: git_repository is required`);
    if (!s.git_branch) errors.push(`${p}: git_branch is required`);
    if (!s.deploy_auth) errors.push(`${p}: deploy_auth is required`);
    if (s.deploy_auth === 'pat' && !s.deploy_token) errors.push(`${p}: deploy_token required when deploy_auth is pat`);
  }

  let totalRecords = 0;
  for (let i = 0; i < dns_zones.length; i++) {
    const z = dns_zones[i];
    const p = `dns_zones[${i}]`;
    if (!z.name) errors.push(`${p}: name is required`);
    if (!z.type) errors.push(`${p}: type is required`);
    if (!Array.isArray(z.records)) { errors.push(`${p}: records must be an array`); continue; }
    const records = z.records as Record<string, unknown>[];
    totalRecords += records.length;
    for (let j = 0; j < records.length; j++) {
      const r = records[j];
      const rp = `${p}.records[${j}]`;
      if (!r.name) errors.push(`${rp}: name is required`);
      if (!r.type) errors.push(`${rp}: type is required`);
      if (r.ttl === undefined || r.ttl === null) errors.push(`${rp}: ttl is required`);
      if (!r.rData) errors.push(`${rp}: rData is required`);
      if (r.type && !KNOWN_RECORD_TYPES.has(r.type as string)) {
        warnings.push(`${rp}: unknown record type '${r.type}'`);
      }
    }
  }

  const summary = { sites: sites.length, dns_zones: dns_zones.length, dns_records: totalRecords };
  if (errors.length) return { valid: false, errors, warnings, summary };

  // Warn on live conflicts
  const coolify = createCoolifyClient();
  const technitium = createTechnitiumClient();

  if (coolify) {
    try {
      const live = await coolify.listApplications();
      const liveNames = new Set(live.map(a => a.name));
      for (const s of sites) {
        if (liveNames.has(s.name as string)) {
          warnings.push(`Site '${s.name}' already exists in Coolify — will be skipped on import`);
        }
      }
    } catch { /* non-fatal */ }
  }

  if (technitium) {
    try {
      const liveZones = await technitium.listZones();
      const liveNames = new Set(liveZones.map(z => z.name));
      for (const z of dns_zones) {
        if (liveNames.has(z.name as string)) {
          warnings.push(`DNS zone '${z.name}' already exists — records will be merged`);
        }
      }
    } catch { /* non-fatal */ }
  }

  return { valid: true, errors: [], warnings, summary };
}

export async function importBackup(data: BackupFile): Promise<ImportResult> {
  const result: ImportResult = {
    sites: { created: [], skipped: [], failed: [] },
    dns: { created: [], skipped: [], failed: [] },
  };

  const coolify = createCoolifyClient();
  const technitium = createTechnitiumClient();

  if (coolify) {
    const liveSites = await coolify.listApplications().catch(() => []);
    const liveNames = new Set(liveSites.map(a => a.name));

    const servers = await coolify.getServers().catch(() => []);
    const server_uuid = servers[0]?.uuid ?? '';
    let destination_uuid = '';
    try { destination_uuid = readFileSync('/coolify-api-token/destination_uuid', 'utf8').trim(); } catch { /* ok */ }

    // Resolve project_uuid — handle race where two imports both try to create the project
    const projects = await coolify.getProjects().catch(() => []);
    let project_uuid = projects[0]?.uuid ?? '';
    if (!project_uuid) {
      const p = await coolify.createProject('hermithost-sites').catch(async (err: Error) => {
        // If creation raced, fetch again
        if (err.message.toLowerCase().includes('already exists')) {
          const retry = await coolify.getProjects().catch(() => []);
          return retry[0] ?? null;
        }
        return null;
      });
      project_uuid = (p as { uuid?: string } | null)?.uuid ?? '';
    }

    for (const site of data.sites) {
      if (liveNames.has(site.name)) {
        result.sites.skipped.push(`${site.name}: already exists`);
        continue;
      }
      if (!server_uuid || !destination_uuid || !project_uuid) {
        result.sites.failed.push(`${site.name}: missing Coolify infra UUIDs`);
        continue;
      }
      try {
        const resolvedRepo = site.deploy_auth === 'pat' && site.deploy_token
          ? embedPatInRepoUrl(site.git_repository, site.deploy_token)
          : site.git_repository;
        // Note: Coolify's type field refers to repo auth method, not visibility.
        // 'public' = PAT/no-key auth, 'private' = SSH key auth. Both use the same
        // /applications/public endpoint in our CoolifyClient.
        const app = await coolify.createApplication({
          type: site.deploy_auth === 'pat' ? 'public' : 'private',
          name: site.name,
          git_repository: resolvedRepo,
          git_branch: site.git_branch,
          build_pack: 'nixpacks',
          ports_exposes: '3000',
          server_uuid,
          destination_uuid,
          project_uuid,
          environment_name: 'production',
          instant_deploy: false,
          ...(site.description ? { description: site.description } : {}),
        });
        if (site.deploy_auth !== 'pat') {
          await linkGithubKey(app.uuid);
        }
        if (site.domain) {
          const coolifyDomain = /^https?:\/\//i.test(site.domain) ? site.domain : `https://${site.domain}`;
          await coolify.updateApplication(app.uuid, { domains: coolifyDomain, force_domain_override: true }).catch(() => {});
          const dnsErr = await provisionSiteDns(site.domain);
          if (dnsErr) {
            // Site created but DNS failed — report with warning suffix so user knows
            result.sites.created.push(`${site.name} [DNS provision failed: ${dnsErr}]`);
            continue;
          }
        }
        result.sites.created.push(site.name);
      } catch (err) {
        result.sites.failed.push(`${site.name}: ${(err as Error).message}`);
      }
    }
  }

  if (technitium) {
    for (const zone of data.dns_zones) {
      try {
        await technitium.createZone(zone.name, zone.type).catch((err: Error) => {
          if (!err.message.toLowerCase().includes('already exists')) throw err;
        });
      } catch (err) {
        result.dns.failed.push(`zone ${zone.name}: ${(err as Error).message}`);
        continue;
      }

      for (const record of zone.records) {
        try {
          const params = new URLSearchParams();
          params.set('type', record.type);
          params.set('ttl', String(record.ttl));
          for (const [key, value] of Object.entries(record.rData)) {
            if (value !== undefined && value !== null) {
              params.set(key, String(value));
            }
          }
          if (record.type === 'SOA') {
            await technitium.updateRecord(zone.name, params);
            result.dns.created.push(`${zone.name} ${record.type} ${record.name}`);
          } else {
            let alreadyExists = false;
            await technitium.addRecord(zone.name, params).catch((err: Error) => {
              const msg = err.message.toLowerCase();
              if (msg.includes('already exists') || msg.includes('duplicate')) {
                alreadyExists = true;
              } else {
                throw err;
              }
            });
            if (alreadyExists) {
              try {
                await technitium.deleteRecord(zone.name, params);
                await technitium.addRecord(zone.name, params);
                result.dns.created.push(`${zone.name} ${record.type} ${record.name} [replaced]`);
              } catch (replaceErr) {
                result.dns.failed.push(`${zone.name} ${record.type} ${record.name}: replace failed — ${(replaceErr as Error).message}`);
              }
            } else {
              result.dns.created.push(`${zone.name} ${record.type} ${record.name}`);
            }
          }
        } catch (err) {
          result.dns.failed.push(`${zone.name} ${record.type} ${record.name}: ${(err as Error).message}`);
        }
      }
    }
  }

  return result;
}
