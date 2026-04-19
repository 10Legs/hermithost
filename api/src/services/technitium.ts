import { readFileSync } from 'fs';

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
