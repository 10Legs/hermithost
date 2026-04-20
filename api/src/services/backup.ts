import { readFileSync } from 'fs';
import { createCoolifyClient } from './coolify';
import { createTechnitiumClient } from './technitium';
import { createDnsProvider } from './dns';
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

// v2 schema: provider-neutral normalized record
export interface BackupDnsRecord {
  name: string;
  type: string;
  ttl: number;
  value: string;
  priority?: number;
}

// v1 schema (legacy): Technitium-specific rData bag
interface BackupDnsRecordV1 {
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
  version: 1 | 2;
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

// ── v1 migration helpers ──────────────────────────────────────────────────────
// Convert a Technitium-format v1 record (rData bag) to normalized v2 format.

function normalizeV1Name(recordName: string, zoneName: string): string {
  if (recordName === zoneName) return '@';
  const suffix = `.${zoneName}`;
  if (recordName.endsWith(suffix)) {
    return recordName.slice(0, -suffix.length);
  }
  return recordName;
}

function extractV1Value(rData: Record<string, unknown>, type: string): string {
  switch (type) {
    case 'A':
    case 'AAAA':   return String(rData.ipAddress ?? '');
    case 'CNAME':  return String(rData.cname ?? '');
    case 'MX':     return String(rData.exchange ?? '');
    case 'TXT':    return String(rData.text ?? '');
    case 'NS':     return String(rData.nameServer ?? '');
    case 'SRV':    return String(rData.target ?? '');
    case 'SOA':    return String(rData.primaryNameServer ?? '');
    case 'CAA':    return rData.value !== undefined
                     ? String(rData.value)
                     : `${rData.flags ?? 0} ${rData.tag ?? ''} ""`;
    case 'PTR':    return String(rData.ptrdname ?? '');
    default:       return '';
  }
}

function extractV1Priority(rData: Record<string, unknown>, type: string): number | undefined {
  if (type === 'MX')  return rData.preference as number | undefined;
  if (type === 'SRV') return rData.priority   as number | undefined;
  return undefined;
}

function migrateV1Zone(zone: { name: string; type: string; records: BackupDnsRecordV1[] }): BackupDnsZone {
  return {
    name: zone.name,
    type: zone.type,
    records: zone.records.map(r => {
      const name     = normalizeV1Name(r.name, zone.name);
      const value    = extractV1Value(r.rData, r.type);
      const priority = extractV1Priority(r.rData, r.type);
      const out: BackupDnsRecord = { name, type: r.type, ttl: r.ttl, value };
      if (priority !== undefined) out.priority = priority;
      return out;
    }),
  };
}

// ── Export ────────────────────────────────────────────────────────────────────

export async function exportBackup(filter?: ExportFilter): Promise<BackupFile> {
  const coolify = createCoolifyClient();

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
  const skipZones = Array.isArray(filter?.zones) && filter!.zones.length === 0;
  if (!skipZones) {
    try {
      const provider = createDnsProvider();
      const zones = await provider.listZones();
      const allowedZones = Array.isArray(filter?.zones) ? new Set(filter!.zones) : null;
      for (const zone of zones) {
        if (zone.internal) continue;
        if (allowedZones && !allowedZones.has(zone.name)) continue;
        const records = await provider.getRecords(zone.name).catch(() => []);
        dns_zones.push({
          name: zone.name,
          type: 'Primary',
          records: records.map(r => {
            const out: BackupDnsRecord = { name: r.name, type: r.type, ttl: r.ttl, value: r.value };
            if (r.priority !== undefined) out.priority = r.priority;
            return out;
          }),
        });
      }
    } catch { /* provider not configured — export sites-only */ }
  }

  return {
    version: 2,
    exported_at: new Date().toISOString(),
    sites,
    dns_zones,
  };
}

// ── Validate ──────────────────────────────────────────────────────────────────

export async function validateBackup(data: unknown): Promise<ValidationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const empty = { sites: 0, dns_zones: 0, dns_records: 0 };

  if (typeof data !== 'object' || data === null) {
    return { valid: false, errors: ['Backup must be a JSON object'], warnings: [], summary: empty };
  }

  const b = data as Record<string, unknown>;
  if (b.version !== 1 && b.version !== 2) errors.push('version must be 1 or 2');
  if (!Array.isArray(b.sites)) errors.push('sites must be an array');
  if (!Array.isArray(b.dns_zones)) errors.push('dns_zones must be an array');
  if (errors.length) return { valid: false, errors, warnings, summary: empty };

  const isV1 = b.version === 1;
  const sites = b.sites as Record<string, unknown>[];
  const dns_zones = b.dns_zones as Record<string, unknown>[];

  for (let i = 0; i < sites.length; i++) {
    const s = sites[i];
    const p = `sites[${i}]`;
    if (!s.name) errors.push(`${p}: name is required`);
    if (!s.domain) {
      errors.push(`${p}: domain is required`);
    } else {
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
      if (isV1) {
        if (!r.rData) errors.push(`${rp}: rData is required`);
      } else {
        if (r.value === undefined || r.value === null) errors.push(`${rp}: value is required`);
      }
      if (r.type && !KNOWN_RECORD_TYPES.has(r.type as string)) {
        warnings.push(`${rp}: unknown record type '${r.type}'`);
      }
    }
  }

  const summary = { sites: sites.length, dns_zones: dns_zones.length, dns_records: totalRecords };
  if (errors.length) return { valid: false, errors, warnings, summary };

  // Warn on live conflicts
  const coolify = createCoolifyClient();

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

  try {
    const provider = createDnsProvider();
    const liveZones = await provider.listZones();
    const liveNames = new Set(liveZones.map(z => z.name));
    for (const z of dns_zones) {
      if (liveNames.has(z.name as string)) {
        warnings.push(`DNS zone '${z.name}' already exists — records will be merged`);
      }
    }
  } catch { /* provider not configured — skip DNS conflict check */ }

  return { valid: true, errors: [], warnings, summary };
}

// ── Import ────────────────────────────────────────────────────────────────────

export async function importBackup(data: BackupFile): Promise<ImportResult> {
  const result: ImportResult = {
    sites: { created: [], skipped: [], failed: [] },
    dns: { created: [], skipped: [], failed: [] },
  };

  const coolify = createCoolifyClient();

  if (coolify) {
    const liveSites = await coolify.listApplications().catch(() => []);
    const liveNames = new Set(liveSites.map(a => a.name));

    const servers = await coolify.getServers().catch(() => []);
    const server_uuid = servers[0]?.uuid ?? '';
    let destination_uuid = '';
    try { destination_uuid = readFileSync('/coolify-api-token/destination_uuid', 'utf8').trim(); } catch { /* ok */ }

    const projects = await coolify.getProjects().catch(() => []);
    let project_uuid = projects[0]?.uuid ?? '';
    if (!project_uuid) {
      const p = await coolify.createProject('hermithost-sites').catch(async (err: Error) => {
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

  // Normalize zones: migrate v1 rData → v2 normalized records
  const zones: BackupDnsZone[] = data.version === 1
    ? (data.dns_zones as unknown as Array<{ name: string; type: string; records: BackupDnsRecordV1[] }>).map(migrateV1Zone)
    : data.dns_zones;

  try {
    const provider = createDnsProvider();

    for (const zone of zones) {
      try {
        await provider.createZone(zone.name);
      } catch {
        // Zone may already exist — provider error messages vary. Verify by listing.
        const allZones = await provider.listZones().catch(() => []);
        if (!allZones.some(z => z.name === zone.name)) {
          result.dns.failed.push(`zone ${zone.name}: zone not found and could not be created`);
          continue;
        }
        // Zone exists — proceed with record import
      }

      // Fetch existing records once per zone — used for SOA check and duplicate detection
      const existing = await provider.getRecords(zone.name).catch(() => []);
      const existingSoa = existing.some(r => r.type === 'SOA');

      for (const record of zone.records) {
        // SOA: skip if provider already auto-provisioned one
        if (record.type === 'SOA' && existingSoa) {
          result.dns.created.push(`${zone.name} SOA ${record.name} [skipped — auto-provisioned]`);
          continue;
        }

        try {
          await provider.addRecord(zone.name, {
            type: record.type as import('../types').DnsRecordType,
            name: record.name,
            value: record.value,
            ttl: record.ttl,
            ...(record.priority !== undefined ? { priority: record.priority } : {}),
          });
          result.dns.created.push(`${zone.name} ${record.type} ${record.name}`);
        } catch {
          // Duplicate detection: re-fetch and look for a matching record
          try {
            const current = await provider.getRecords(zone.name).catch(() => []);
            const dup = current.find(r =>
              r.type === record.type &&
              r.name === record.name &&
              r.value === record.value
            );
            if (dup) {
              await provider.deleteRecord(zone.name, dup.id);
              await provider.addRecord(zone.name, {
                type: record.type as import('../types').DnsRecordType,
                name: record.name,
                value: record.value,
                ttl: record.ttl,
                ...(record.priority !== undefined ? { priority: record.priority } : {}),
              });
              result.dns.created.push(`${zone.name} ${record.type} ${record.name} [replaced]`);
            } else {
              result.dns.failed.push(`${zone.name} ${record.type} ${record.name}: add failed — no duplicate found`);
            }
          } catch (replaceErr) {
            result.dns.failed.push(`${zone.name} ${record.type} ${record.name}: ${(replaceErr as Error).message}`);
          }
        }
      }
    }
  } catch (err) {
    // Provider not configured — DNS import skipped
    const msg = (err as Error).message;
    for (const zone of zones) {
      result.dns.failed.push(`zone ${zone.name}: DNS provider error — ${msg}`);
    }
  }

  return result;
}
