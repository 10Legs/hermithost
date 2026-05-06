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

  private async getZoneId(domain: string): Promise<string> {
    const { zoneId } = await this.getZoneAndName(domain);
    return zoneId;
  }



  private async getZoneAndName(domain: string): Promise<{ zoneId: string; recordName: string; zoneName: string }> {
    const parts = domain.split('.');
    for (let i = 0; i < parts.length - 1; i++) {
      const candidate = parts.slice(i).join('.');
      if (this.zoneCache.has(candidate)) {
        const zoneId = this.zoneCache.get(candidate)!;
        const recordName = i === 0 ? '@' : parts.slice(0, i).join('.');
        return { zoneId, recordName, zoneName: candidate };
      }
      const zones = await this.cfFetch<CfZone[]>(
        `/zones?name=${encodeURIComponent(candidate)}`
      );
      if (zones.length > 0) {
        const zoneId = zones[0].id;
        this.zoneCache.set(candidate, zoneId);
        const recordName = i === 0 ? '@' : parts.slice(0, i).join('.');
        return { zoneId, recordName, zoneName: candidate };
      }
    }
    throw new DnsOperationError(`Cloudflare zone not found for domain: ${domain}`, null);
  }

  private static readonly VALID_RECORD_TYPES = new Set<string>([
    'A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SRV', 'CAA', 'SOA', 'PTR',
  ]);

  private mapRecord(r: CfRecord, zoneName?: string): DnsRecord | null {
    if (!CloudflareProvider.VALID_RECORD_TYPES.has(r.type)) {
      console.warn(`Skipping unsupported Cloudflare record type: ${r.type}`);
      return null;
    }
    // Normalize FQDN → relative name (e.g. "www.example.com" → "www", "example.com" → "@")
    let name = r.name;
    if (zoneName) {
      if (name === zoneName) {
        name = '@';
      } else if (name.endsWith(`.${zoneName}`)) {
        name = name.slice(0, -(zoneName.length + 1));
      }
    }
    return {
      id: r.id,
      type: r.type as DnsRecordType,
      name,
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
    // Use raw fetch here so we can inspect Cloudflare error codes before
    // deciding whether to throw. cfFetch collapses errors into a string and
    // discards the code, making idempotency checks impossible.
    const res = await fetch(`${CF_BASE}/zones`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ name, type: 'full', jump_start: false }),
    });
    const data = await res.json() as CfResponse<CfZone>;
    if (!data.success) {
      // 1061 = "already exists" — treat as success (idempotent).
      if (data.errors.some((e) => e.code === 1061)) {
        // Zone already exists; populate the cache so subsequent calls avoid
        // an extra lookup, but only if we don't already have it cached.
        if (!this.zoneCache.has(name)) {
          try {
            const zones = await this.cfFetch<CfZone[]>(
              `/zones?name=${encodeURIComponent(name)}`
            );
            if (zones.length > 0) this.zoneCache.set(name, zones[0].id);
          } catch {
            // Cache miss is non-fatal; getZoneId will fetch on demand.
          }
        }
        return;
      }
      const msg = data.errors[0]?.message ?? `Cloudflare API error (HTTP ${res.status})`;
      throw new DnsOperationError('Failed to create Cloudflare zone', new Error(msg));
    }
    this.zoneCache.set(name, data.result.id);
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
      const { zoneId, recordName, zoneName } = await this.getZoneAndName(domain);
      // If domain is the zone apex, return all records. If it's a subdomain,
      // filter to only records for that specific name — prevents sites on the
      // same parent zone from seeing each other's records.
      const nameFilter = recordName === '@' ? '' : `&name=${encodeURIComponent(domain)}`;
      const records = await this.cfFetch<CfRecord[]>(`/zones/${zoneId}/dns_records?per_page=100${nameFilter}`);
      return records.map((r) => this.mapRecord(r, zoneName)).filter((r): r is DnsRecord => r !== null);
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
