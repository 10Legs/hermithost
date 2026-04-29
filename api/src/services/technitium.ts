import { readFileSync } from 'fs';
import { randomBytes } from 'crypto';
import { Resolver } from 'dns/promises';
import { isIPv4, isIPv6 } from 'net';

// Technitium DNS Server API client — typed, using Node 18+ native fetch only.
// Auth is passed as a query parameter on every request per Technitium's API design.
// All endpoints use POST with application/x-www-form-urlencoded bodies.

export interface TechnitiumZone {
  name: string;
  type: string;
  disabled: boolean;
  internal: boolean;
  dnssecStatus: string;
}

export interface TechnitiumRData {
  // A / AAAA
  ipAddress?: string;
  // CNAME
  cname?: string;
  // MX
  preference?: number;
  exchange?: string;
  // TXT
  text?: string;
  // NS
  nameServer?: string;
  // SRV
  priority?: number;
  weight?: number;
  port?: number;
  target?: string;
  // SOA
  primaryNameServer?: string;
  responsiblePerson?: string;
  serial?: number;
  refresh?: number;
  retry?: number;
  expire?: number;
  minimum?: number;
  // CAA
  tag?: string;
  flags?: number;
  value?: string;
  // PTR
  ptrdname?: string;
}

export interface TechnitiumRecord {
  disabled: boolean;
  name: string;
  type: string;
  ttl: number;
  rData: TechnitiumRData;
}

export interface TechnitiumZoneListResponse {
  response: { zones: TechnitiumZone[] };
  status: string;
  errorMessage?: string;
}

export interface TechnitiumZoneResponse {
  status: string;
  errorMessage?: string;
}

export interface TechnitiumGetRecordsResponse {
  response: {
    zone: TechnitiumZone;
    records: TechnitiumRecord[];
  };
  status: string;
  errorMessage?: string;
}

export interface TechnitiumMutateResponse {
  response: {
    addedRecord?: TechnitiumRecord;
    updatedRecord?: TechnitiumRecord;
  };
  status: string;
  errorMessage?: string;
}

export interface TechnitiumDeleteResponse {
  status: string;
  errorMessage?: string;
}

export type RecursionMode = 'Disabled' | 'LanOnly' | 'Public';

// Single source of truth for the safe recursion ACL baseline.
// Referenced by setRecursion, setRecursionWithExtraAcl, and trustClient.
const SAFE_RECURSION_ACL_ENTRIES: readonly string[] = [
  '127.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '::1/128', 'fd00::/8',
];

export type DiagnoseResult = {
  recursion_working: boolean;
  current_mode: RecursionMode;
  current_acl: string[];
  untrusted_clients: Array<{
    ip: string;
    rdns: string | null;     // reverse-DNS from Technitium `domain` field, or null if no PTR
    hits: number;
    in_acl: boolean;
  }>;
};

export interface TechnitiumGetRecordsResult {
  zone: TechnitiumZone;
  records: TechnitiumRecord[];
}

async function handleResponse<T extends { status: string; errorMessage?: string }>(
  res: Response,
  context: string
): Promise<T> {
  if (!res.ok) {
    const body = await res.text().catch(() => '(unreadable)');
    throw new Error(`Technitium ${context} failed: HTTP ${res.status} — ${body}`);
  }
  const data = (await res.json()) as T;
  if (data.status !== 'ok') {
    throw new Error(`Technitium ${context} error: ${data.errorMessage ?? data.status}`);
  }
  return data;
}

export class TechnitiumClient {
  private readonly baseUrl: string;
  private token: string;
  private readonly username: string;
  private readonly password: string;
  private readonly postHeaders: Record<string, string>;

  constructor(baseUrl: string, token: string, username = 'admin', password = 'admin') {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = token;
    this.username = username;
    this.password = password;
    this.postHeaders = {
      'Content-Type': 'application/x-www-form-urlencoded',
    };
  }

  private async refreshToken(): Promise<void> {
    const params = new URLSearchParams({ user: this.username, pass: this.password, includeInfo: 'false' });
    const res = await fetch(`${this.baseUrl}/api/user/login?${params}`);
    const data = await res.json() as { status: string; token?: string; errorMessage?: string };
    if (data.status !== 'ok' || !data.token) {
      throw new Error(`Technitium login failed: ${data.errorMessage ?? data.status}`);
    }
    this.token = data.token;
  }

  private isTokenError(err: unknown): boolean {
    return (err as Error)?.message?.includes('Invalid token or session expired') ?? false;
  }

  private async withTokenRetry<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (this.isTokenError(err)) {
        await this.refreshToken();
        return fn();
      }
      throw err;
    }
  }

  private buildParams(fields: Record<string, string | number | boolean>): URLSearchParams {
    const params = new URLSearchParams();
    params.set('token', this.token);
    for (const [key, value] of Object.entries(fields)) {
      params.set(key, String(value));
    }
    return params;
  }

  async getRecords(domain: string): Promise<TechnitiumGetRecordsResult> {
    return this.withTokenRetry(async () => {
      const body = this.buildParams({ domain, listZone: 'true' });
      const res = await fetch(`${this.baseUrl}/api/zones/records/get`, { method: 'POST', headers: this.postHeaders, body });
      const data = await handleResponse<TechnitiumGetRecordsResponse>(res, 'POST /api/zones/records/get');
      return { zone: data.response.zone, records: data.response.records };
    });
  }

  async addRecord(domain: string, params: URLSearchParams): Promise<TechnitiumRecord> {
    return this.withTokenRetry(async () => {
      params.set('token', this.token);
      params.set('domain', domain);
      const res = await fetch(`${this.baseUrl}/api/zones/records/add`, { method: 'POST', headers: this.postHeaders, body: params });
      const data = await handleResponse<TechnitiumMutateResponse>(res, 'POST /api/zones/records/add');
      if (!data.response.addedRecord) throw new Error('Technitium add record: response missing addedRecord');
      return data.response.addedRecord;
    });
  }

  async updateRecord(domain: string, params: URLSearchParams): Promise<TechnitiumRecord> {
    return this.withTokenRetry(async () => {
      params.set('token', this.token);
      params.set('domain', domain);
      const res = await fetch(`${this.baseUrl}/api/zones/records/update`, { method: 'POST', headers: this.postHeaders, body: params });
      const data = await handleResponse<TechnitiumMutateResponse>(res, 'POST /api/zones/records/update');
      const updated = data.response.updatedRecord ?? data.response.addedRecord;
      if (!updated) throw new Error('Technitium update record: response missing record');
      return updated;
    });
  }

  async listZones(): Promise<TechnitiumZone[]> {
    return this.withTokenRetry(async () => {
      const body = this.buildParams({});
      const res = await fetch(`${this.baseUrl}/api/zones/list`, { method: 'POST', headers: this.postHeaders, body });
      const data = await handleResponse<TechnitiumZoneListResponse>(res, 'POST /api/zones/list');
      return data.response.zones;
    });
  }

  async createZone(name: string, type = 'Primary'): Promise<void> {
    return this.withTokenRetry(async () => {
      const body = this.buildParams({ zone: name, type });
      const res = await fetch(`${this.baseUrl}/api/zones/create`, { method: 'POST', headers: this.postHeaders, body });
      await handleResponse<TechnitiumZoneResponse>(res, 'POST /api/zones/create');
    });
  }

  async deleteZone(name: string): Promise<void> {
    return this.withTokenRetry(async () => {
      const body = this.buildParams({ zone: name });
      const res = await fetch(`${this.baseUrl}/api/zones/delete`, { method: 'POST', headers: this.postHeaders, body });
      await handleResponse<TechnitiumZoneResponse>(res, 'POST /api/zones/delete');
    });
  }

  async deleteRecord(domain: string, params: URLSearchParams): Promise<void> {
    return this.withTokenRetry(async () => {
      params.set('token', this.token);
      params.set('domain', domain);
      const res = await fetch(`${this.baseUrl}/api/zones/records/delete`, { method: 'POST', headers: this.postHeaders, body: params });
      await handleResponse<TechnitiumDeleteResponse>(res, 'POST /api/zones/records/delete');
    });
  }

  async setDnsServerDomain(domain: string): Promise<void> {
    return this.withTokenRetry(async () => {
      const body = this.buildParams({ dnsServerDomain: domain });
      const res = await fetch(`${this.baseUrl}/api/settings/set`, { method: 'POST', headers: this.postHeaders, body });
      await handleResponse<TechnitiumDeleteResponse>(res, 'POST /api/settings/set');
    });
  }

  async setForwarders(forwarderIps: string[]): Promise<void> {
    return this.withTokenRetry(async () => {
      const active = forwarderIps.filter(ip => ip.trim());
      const body = this.buildParams({
        forwarders: active.join(','),
        enableForwarders: active.length > 0,
      });
      const res = await fetch(`${this.baseUrl}/api/settings/set`, { method: 'POST', headers: this.postHeaders, body });
      await handleResponse<TechnitiumDeleteResponse>(res, 'POST /api/settings/set');
    });
  }

  private async getRecursionSettings(): Promise<{ mode: RecursionMode; acl: string[] }> {
    return this.withTokenRetry(async () => {
      const body = this.buildParams({});
      const res = await fetch(`${this.baseUrl}/api/settings/get`, { method: 'POST', headers: this.postHeaders, body });
      const data = await res.json() as { status: string; errorMessage?: string; response?: { recursion?: string; recursionNetworkACL?: string | string[] } };
      if (data.status !== 'ok') throw new Error(`Technitium /api/settings/get error: ${data.errorMessage ?? data.status}`);
      const recursion = data.response?.recursion ?? '';
      const aclRaw = data.response?.recursionNetworkACL ?? '';
      // Technitium returns recursionNetworkACL as an array; older builds returned a comma-string. Handle both.
      const acl = (Array.isArray(aclRaw) ? aclRaw : String(aclRaw).split(','))
        .map(s => String(s).trim())
        .filter(Boolean);
      let mode: RecursionMode;
      switch (recursion) {
        case 'Deny':  mode = 'Disabled'; break;
        case 'Allow': mode = 'Public'; break;
        case 'UseSpecifiedNetworkACL': mode = 'LanOnly'; break;
        default:
          // AllowOnlyForPrivateNetworks (broken default) or unrecognized value.
          // Surface drift for observability; UI shows safe default until reconciled.
          console.warn(`[technitium] getRecursion: unrecognized Technitium recursion="${recursion}" acl="${aclRaw}" — reporting as LanOnly`);
          mode = 'LanOnly';
      }
      return { mode, acl };
    });
  }

  async getRecursion(): Promise<RecursionMode> {
    const { mode } = await this.getRecursionSettings();
    return mode;
  }

  async getRecursionAcl(): Promise<string[]> {
    const { acl } = await this.getRecursionSettings();
    return acl;
  }

  async setRecursion(mode: RecursionMode): Promise<void> {
    return this.withTokenRetry(async () => {
      const technitiumRecursion: Record<RecursionMode, string> = {
        Disabled: 'Deny',
        LanOnly:  'UseSpecifiedNetworkACL',
        Public:   'Allow',
      };
      const technitiumAcl: Record<RecursionMode, string> = {
        Disabled: '',
        LanOnly:  SAFE_RECURSION_ACL_ENTRIES.join(','),
        Public:   '',
      };
      const body = this.buildParams({
        recursion:           technitiumRecursion[mode],
        recursionNetworkACL: technitiumAcl[mode],
      });
      const res = await fetch(`${this.baseUrl}/api/settings/set`, { method: 'POST', headers: this.postHeaders, body });
      await handleResponse<TechnitiumDeleteResponse>(res, 'POST /api/settings/set (recursion)');
    });
  }

  // Sets recursion to LanOnly and merges extraCidrs into the safe baseline ACL.
  // Implementer note: chosen over mutating setRecursion() to keep the baseline-only
  // path simple and unchanged; this variant is additive-only, never destructive.
  async setRecursionWithExtraAcl(mode: RecursionMode, extraCidrs: string[]): Promise<void> {
    return this.withTokenRetry(async () => {
      const technitiumRecursion: Record<RecursionMode, string> = {
        Disabled: 'Deny',
        LanOnly:  'UseSpecifiedNetworkACL',
        Public:   'Allow',
      };
      // Merge: safe baseline + caller-supplied extras, deduplicated.
      const merged = Array.from(new Set([...SAFE_RECURSION_ACL_ENTRIES, ...extraCidrs]));
      const technitiumAcl: Record<RecursionMode, string> = {
        Disabled: '',
        LanOnly:  merged.join(','),
        Public:   '',
      };
      const body = this.buildParams({
        recursion:           technitiumRecursion[mode],
        recursionNetworkACL: technitiumAcl[mode],
      });
      const res = await fetch(`${this.baseUrl}/api/settings/set`, { method: 'POST', headers: this.postHeaders, body });
      await handleResponse<TechnitiumDeleteResponse>(res, 'POST /api/settings/set (recursion+acl)');
    });
  }

  async diagnoseRecursion(): Promise<DiagnoseResult> {
    const { mode, acl } = await this.getRecursionSettings();

    // Active probe: resolve a guaranteed-NXDOMAIN synthetic name through Technitium:53.
    // We only care whether Technitium refuses the query, not the answer.
    let recursion_working = true;
    try {
      const resolver = new Resolver();
      resolver.setServers(['technitium']);
      const probeName = `recursion-probe-${randomBytes(4).toString('hex')}.example.invalid`;
      await resolver.resolve4(probeName);
      // Any answer (even NXDOMAIN which throws) means NOT refused — caught below.
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (code === 'EREFUSED' || code === 'ECONNREFUSED') {
        recursion_working = false;
      }
      // ENOTFOUND / ENODATA = NXDOMAIN → resolver answered → recursion is working.
    }

    // Pull topClients from LastHour stats.
    // Technitium returns topClients at response.topClients (sibling of stats, not nested under it).
    // Each entry: { name: "<ip>", domain: "<rdns or empty>", hits: N }
    type StatsResponse = {
      status: string;
      errorMessage?: string;
      response?: {
        topClients?: Array<{ name: string; domain?: string; hits: number }>;
      };
    };
    const statsBody = this.buildParams({ type: 'LastHour' });
    const statsRes = await fetch(`${this.baseUrl}/api/dashboard/stats/get?type=LastHour`, {
      method: 'POST',
      headers: this.postHeaders,
      body: statsBody,
    });
    const statsData = await statsRes.json() as StatsResponse;
    const topClients: Array<{ name: string; domain?: string; hits: number }> =
      statsData.response?.topClients ?? [];

    // Filter to clients NOT covered by any ACL entry.
    // ip is in `name`; reverse-DNS (if resolved) is in `domain`.
    const untrusted_clients = topClients
      .filter(c => {
        const ip = c.name.trim();
        return ip && !acl.some(cidr => cidrContainsIp(cidr, ip));
      })
      .map(c => ({
        ip: c.name.trim(),
        rdns: c.domain?.trim() || null,
        hits: c.hits,
        in_acl: false as const,
      }));

    return { recursion_working, current_mode: mode, current_acl: acl, untrusted_clients };
  }

  async trustClient(ip: string): Promise<{ acl: string[] }> {
    // Validate: must be a bare IPv4 or IPv6 address — no CIDR, no garbage.
    if (!isValidBareIp(ip)) {
      throw new Error(`Invalid IP address: "${ip}"`);
    }

    const { mode, acl } = await this.getRecursionSettings();

    // No-op if already covered.
    if (acl.some(cidr => cidrContainsIp(cidr, ip))) {
      return { acl };
    }

    const hostCidr = isIPv6(ip) ? `${ip}/128` : `${ip}/32`;
    const newAcl = [...acl, hostCidr];

    await this.setRecursionWithExtraAcl(mode === 'LanOnly' ? 'LanOnly' : mode, newAcl.filter(e => {
      // Only pass the user-added extras; setRecursionWithExtraAcl merges with safe baseline.
      return !SAFE_RECURSION_ACL_ENTRIES.includes(e);
    }));

    return { acl: newAcl };
  }
}

// ---------------------------------------------------------------------------
// Pure helpers — no dependencies beyond Node built-ins
// ---------------------------------------------------------------------------

/**
 * Returns true if `ip` falls within the network described by `cidr`.
 * Handles IPv4 (e.g. "10.0.0.0/8") and IPv6 (e.g. "fd00::/8").
 * Returns false on any parse error rather than throwing.
 */
export function cidrContainsIp(cidr: string, ip: string): boolean {
  try {
    const slashIdx = cidr.lastIndexOf('/');
    if (slashIdx === -1) return cidr === ip;
    const network = cidr.slice(0, slashIdx);
    const prefix = parseInt(cidr.slice(slashIdx + 1), 10);

    // Normalize IPv4-mapped IPv6 (::ffff:a.b.c.d) for cross-family matching.
    const v4MappedIpMatch = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
    const v4MappedNetMatch = network.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);

    // Case: ip is IPv4-mapped IPv6, cidr is plain IPv4
    if (v4MappedIpMatch && isIPv4(network)) {
      return ipv4InCidr(network, v4MappedIpMatch[1], prefix);
    }
    // Case: cidr network is IPv4-mapped IPv6, ip is plain IPv4
    if (v4MappedNetMatch && isIPv4(ip)) {
      return ipv4InCidr(v4MappedNetMatch[1], ip, prefix);
    }

    if (isIPv4(network) && isIPv4(ip)) {
      return ipv4InCidr(network, ip, prefix);
    }
    if (isIPv6(network) && isIPv6(ip)) {
      return ipv6InCidr(network, ip, prefix);
    }
    return false;
  } catch {
    return false;
  }
}

function ipv4ToUint32(ip: string): number {
  return ip.split('.').reduce((acc, octet) => (acc << 8) | parseInt(octet, 10), 0) >>> 0;
}

function ipv4InCidr(network: string, ip: string, prefix: number): boolean {
  if (prefix < 0 || prefix > 32) return false;
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
  return (ipv4ToUint32(network) & mask) === (ipv4ToUint32(ip) & mask);
}

/**
 * Expands an IPv6 address to a 16-byte Uint8Array.
 * Handles compressed notation (::) and IPv4-mapped (::ffff:a.b.c.d).
 */
function ipv6ToBytes(ip: string): Uint8Array {
  // Handle IPv4-mapped: ::ffff:a.b.c.d
  const v4mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (v4mapped) {
    const v4 = ipv4ToUint32(v4mapped[1]);
    const bytes = new Uint8Array(16);
    bytes[10] = 0xff; bytes[11] = 0xff;
    bytes[12] = (v4 >>> 24) & 0xff;
    bytes[13] = (v4 >>> 16) & 0xff;
    bytes[14] = (v4 >>> 8) & 0xff;
    bytes[15] = v4 & 0xff;
    return bytes;
  }
  // Expand ::
  const halves = ip.split('::');
  const left  = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  const groups = [...left, ...Array(missing).fill('0'), ...right];
  const bytes = new Uint8Array(16);
  groups.forEach((g, i) => {
    const v = parseInt(g, 16);
    bytes[i * 2]     = (v >>> 8) & 0xff;
    bytes[i * 2 + 1] = v & 0xff;
  });
  return bytes;
}

function ipv6InCidr(network: string, ip: string, prefix: number): boolean {
  if (prefix < 0 || prefix > 128) return false;
  const netBytes = ipv6ToBytes(network);
  const ipBytes  = ipv6ToBytes(ip);
  let bitsLeft = prefix;
  for (let i = 0; i < 16; i++) {
    if (bitsLeft >= 8) {
      if (netBytes[i] !== ipBytes[i]) return false;
      bitsLeft -= 8;
    } else if (bitsLeft > 0) {
      const mask = ~(0xff >>> bitsLeft) & 0xff;
      if ((netBytes[i] & mask) !== (ipBytes[i] & mask)) return false;
      bitsLeft = 0;
    } else {
      break;
    }
  }
  return true;
}

/**
 * Strict validation: bare IPv4 or IPv6 only — no CIDR, no whitespace, no commas.
 * Uses net.isIP() plus a sanity-check regex to guard against edge cases.
 */
export function isValidBareIp(input: string): boolean {
  if (typeof input !== 'string') return false;
  // Reject anything containing CIDR slash, commas, or whitespace.
  if (/[/,\s]/.test(input)) return false;
  // Only allow characters valid in IPv4/IPv6 addresses.
  if (!/^[0-9a-fA-F:.]+$/.test(input)) return false;
  return isIPv4(input) || isIPv6(input);
}

// Module-level exports wrapping the client instance for convenience.
// Callers should prefer using TechnitiumClient directly if they already hold a reference.
export async function diagnoseRecursion(): Promise<DiagnoseResult> {
  const client = createTechnitiumClient();
  if (!client) throw new Error('Technitium client not configured');
  return client.diagnoseRecursion();
}

export async function trustClient(ip: string): Promise<{ acl: string[] }> {
  const client = createTechnitiumClient();
  if (!client) throw new Error('Technitium client not configured');
  return client.trustClient(ip);
}

export function createTechnitiumClient(
  baseUrl?: string,
  token?: string
): TechnitiumClient | null {
  const url = baseUrl ?? process.env.TECHNITIUM_URL;
  if (!url) return null;
  // File token (written by coolify-server-setup init container) takes priority —
  // it's a permanent API token recreated on every stack boot.
  let tok = token ?? '';
  if (!tok) {
    try {
      tok = readFileSync('/coolify-api-token/technitium_token', 'utf8').trim();
    } catch { /* file not present — fall through to env var */ }
  }
  if (!tok) {
    tok = process.env.TECHNITIUM_TOKEN ?? '';
  }
  const user = process.env.TECHNITIUM_USER ?? 'admin';
  const pass = process.env.TECHNITIUM_PASS ?? 'admin';
  return new TechnitiumClient(url, tok, user, pass);
}
