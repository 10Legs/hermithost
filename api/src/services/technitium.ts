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
  cName?: string;
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
  if (data.status === 'error') {
    throw new Error(`Technitium ${context} error: ${data.errorMessage ?? 'unknown error'}`);
  }
  return data;
}

export class TechnitiumClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly postHeaders: Record<string, string>;

  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = token;
    this.postHeaders = {
      'Content-Type': 'application/x-www-form-urlencoded',
    };
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
    const body = this.buildParams({ domain, listZone: 'true' });
    const res = await fetch(`${this.baseUrl}/api/zone/getRecords`, {
      method: 'POST',
      headers: this.postHeaders,
      body,
    });
    const data = await handleResponse<TechnitiumGetRecordsResponse>(res, 'POST /api/zone/getRecords');
    return {
      zone: data.response.zone,
      records: data.response.records,
    };
  }

  async addRecord(
    domain: string,
    params: URLSearchParams
  ): Promise<TechnitiumRecord> {
    params.set('token', this.token);
    params.set('domain', domain);
    const res = await fetch(`${this.baseUrl}/api/zones/records/add`, {
      method: 'POST',
      headers: this.postHeaders,
      body: params,
    });
    const data = await handleResponse<TechnitiumMutateResponse>(res, 'POST /api/zones/records/add');
    if (!data.response.addedRecord) {
      throw new Error('Technitium add record: response missing addedRecord');
    }
    return data.response.addedRecord;
  }

  async updateRecord(
    domain: string,
    params: URLSearchParams
  ): Promise<TechnitiumRecord> {
    params.set('token', this.token);
    params.set('domain', domain);
    const res = await fetch(`${this.baseUrl}/api/zones/records/update`, {
      method: 'POST',
      headers: this.postHeaders,
      body: params,
    });
    const data = await handleResponse<TechnitiumMutateResponse>(res, 'POST /api/zones/records/update');
    const updated = data.response.updatedRecord ?? data.response.addedRecord;
    if (!updated) {
      throw new Error('Technitium update record: response missing record');
    }
    return updated;
  }

  async deleteRecord(
    domain: string,
    params: URLSearchParams
  ): Promise<void> {
    params.set('token', this.token);
    params.set('domain', domain);
    const res = await fetch(`${this.baseUrl}/api/zones/records/delete`, {
      method: 'POST',
      headers: this.postHeaders,
      body: params,
    });
    await handleResponse<TechnitiumDeleteResponse>(res, 'POST /api/zones/records/delete');
  }
}

export function createTechnitiumClient(
  baseUrl?: string,
  token?: string
): TechnitiumClient | null {
  const url = baseUrl ?? process.env.TECHNITIUM_URL;
  const tok = token ?? process.env.TECHNITIUM_TOKEN;
  if (!url || !tok) return null;
  return new TechnitiumClient(url, tok);
}
