// Cloudflare DNS provider — uses Node 18+ native fetch.
// Auth: Authorization: Bearer <token>
// Base: https://api.cloudflare.com/client/v4

import type { DnsProvider, DnsZone } from './DnsProvider';
import type { DnsRecord, DnsRecordType } from '../../types';
import { DnsOperationError } from './errors';

const CF_BASE = 'https://api.cloudflare.com/client/v4';

interface CfError {
  code: number;
  message: string;
}

interface CfResponse<T> {
  success: boolean;
  errors: CfError[];
  result: T;
}

interface CfZone {
  id: string;
  name: string;
  status: string;
  paused: boolean;
}

interface CfRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  ttl: number;
  priority?: number;
  proxied?: boolean;
}

export class CloudflareProvider implements DnsProvider {
  private readonly headers: Record<string, string>;
  /** Zone name → zone ID cache (lives for the lifetime of this instance). */
  private readonly zoneCache = new Map<string, string>();

  constructor(private readonly token: string) {
    this.headers = {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    };
  }

  // ── Internal helpers ───────────────────────────────────────────

  private async cfFetch<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${CF_BASE}${path}`, {
      ...init,
      headers: { ...this.headers, ...(init?.headers ?? {}) },
    });
    const data = await res.json() as CfResponse<T>;
    if (!data.success) {
      const msg = data.errors[0]?.message ?? `Cloudflare API error (HTTP ${res.status})`;
      throw new Error(msg);
    }
    return data.result;
  }

  private async getZoneId(name: string): Promise<string> {
    if (this.zoneCache.has(name)) return this.zoneCache.get(name)!;
    const zones = await this.cfFetch<CfZone[]>(`/zones?name=${encodeURIComponent(name)}&per_page=1`);
    if (!zones.length) throw new Error(`Cloudflare zone not found: ${name}`);
    const id = zones[0].id;
    this.zoneCache.set(name, id);
    return id;
  }

  private static readonly VALID_RECORD_TYPES = new Set<string>([
    'A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SRV', 'CAA', 'SOA', 'PTR',
  ]);

  private mapRecord(r: CfRecord): DnsRecord | null {
    if (!CloudflareProvider.VALID_RECORD_TYPES.has(r.type)) {
      console.warn(`Skipping unsupported Cloudflare record type: ${r.type}`);
      return null;
    }
    return {
      id: r.id,
      type: r.type as DnsRecordType,
      name: r.name,
      value: r.content,
      ttl: r.ttl,
      ...(r.priority !== undefined ? { priority: r.priority } : {}),
    };
  }

  // ── Zone methods ───────────────────────────────────────────────

  async listZones(): Promise<DnsZone[]> {
    try {
      const zones = await this.cfFetch<CfZone[]>('/zones?per_page=50');
      return zones.map((z) => ({ name: z.name, disabled: z.paused }));
    } catch (err) {
      throw new DnsOperationError('Failed to list Cloudflare zones', err);
    }
  }

  async createZone(name: string): Promise<void> {
    try {
      const zone = await this.cfFetch<CfZone>('/zones', {
        method: 'POST',
        body: JSON.stringify({ name, type: 'full', jump_start: false }),
      });
      this.zoneCache.set(name, zone.id);
    } catch (err) {
      throw new DnsOperationError('Failed to create Cloudflare zone', err);
    }
  }

  async deleteZone(name: string): Promise<void> {
    try {
      const id = await this.getZoneId(name);
      await this.cfFetch<{ id: string }>(`/zones/${id}`, { method: 'DELETE' });
      this.zoneCache.delete(name);
    } catch (err) {
      throw new DnsOperationError('Failed to delete Cloudflare zone', err);
    }
  }

  // ── Record methods ─────────────────────────────────────────────

  async getRecords(domain: string): Promise<DnsRecord[]> {
    try {
      const id = await this.getZoneId(domain);
      const records = await this.cfFetch<CfRecord[]>(`/zones/${id}/dns_records?per_page=100`);
      return records.map((r) => this.mapRecord(r)).filter((r): r is DnsRecord => r !== null);
    } catch (err) {
      throw new DnsOperationError('Failed to retrieve Cloudflare DNS records', err);
    }
  }

  async addRecord(domain: string, record: Omit<DnsRecord, 'id'>): Promise<DnsRecord> {
    try {
      const id = await this.getZoneId(domain);
      const body: Record<string, unknown> = {
        type: record.type,
        name: record.name === '@' ? domain : `${record.name}.${domain}`,
        content: record.value,
        ttl: record.ttl,
        proxied: false,
      };
      if (record.priority !== undefined) body.priority = record.priority;
      const created = await this.cfFetch<CfRecord>(`/zones/${id}/dns_records`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      const result = this.mapRecord(created);
      if (!result) throw new DnsOperationError('Cloudflare returned unsupported record type', null);
      return result;
    } catch (err) {
      throw new DnsOperationError('Failed to add Cloudflare DNS record', err);
    }
  }

  async updateRecord(
    domain: string,
    id: string,
    updates: Partial<Omit<DnsRecord, 'id'>>
  ): Promise<DnsRecord> {
    try {
      const zoneId = await this.getZoneId(domain);
      const patch: Record<string, unknown> = {};
      if (updates.type !== undefined) patch.type = updates.type;
      if (updates.name !== undefined) patch.name = updates.name;
      if (updates.value !== undefined) patch.content = updates.value;
      if (updates.ttl !== undefined) patch.ttl = updates.ttl;
      if (updates.priority !== undefined) patch.priority = updates.priority;
      const updated = await this.cfFetch<CfRecord>(`/zones/${zoneId}/dns_records/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
      const result = this.mapRecord(updated);
      if (!result) throw new DnsOperationError('Cloudflare returned unsupported record type', null);
      return result;
    } catch (err) {
      throw new DnsOperationError('Failed to update Cloudflare DNS record', err);
    }
  }

  async deleteRecord(domain: string, id: string): Promise<void> {
    try {
      const zoneId = await this.getZoneId(domain);
      await this.cfFetch<{ id: string }>(`/zones/${zoneId}/dns_records/${id}`, {
        method: 'DELETE',
      });
    } catch (err) {
      throw new DnsOperationError('Failed to delete Cloudflare DNS record', err);
    }
  }
}
