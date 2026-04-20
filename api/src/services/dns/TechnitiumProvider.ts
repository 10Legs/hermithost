import type { DnsProvider, DnsZone } from './DnsProvider';
import type { DnsRecord } from '../../types';
import { TechnitiumClient } from '../technitium';
import {
  mapRecord,
  shouldIncludeRecord,
  buildAddParams,
  buildUpdateParams,
  buildDeleteParams,
  decodeId,
} from '../technitiumMapper';
import { DnsOperationError } from './errors';

export class TechnitiumProvider implements DnsProvider {
  constructor(private readonly client: TechnitiumClient) {}

  async getRecords(domain: string): Promise<DnsRecord[]> {
    try {
      const { zone, records } = await this.client.getRecords(domain);
      return records
        .filter((r) => shouldIncludeRecord(r, zone.name))
        .map((r) => mapRecord(r, zone.name));
    } catch (err) {
      throw new DnsOperationError('Failed to retrieve DNS records', err);
    }
  }

  async addRecord(domain: string, record: Omit<DnsRecord, 'id'>): Promise<DnsRecord> {
    try {
      const fullDomain = record.name === '@' ? domain : `${record.name}.${domain}`;
      const dnsRecord: DnsRecord = { id: '', ...record };
      const params = buildAddParams(fullDomain, dnsRecord);
      const raw = await this.client.addRecord(fullDomain, params);
      const { zone } = await this.client.getRecords(domain);
      return mapRecord(raw, zone.name);
    } catch (err) {
      throw new DnsOperationError('Failed to add DNS record', err);
    }
  }

  async updateRecord(
    domain: string,
    id: string,
    updates: Partial<Omit<DnsRecord, 'id'>>
  ): Promise<DnsRecord> {
    try {
      const identity = decodeId(id);
      const existing: DnsRecord = {
        id,
        type: identity.type as DnsRecord['type'],
        name: identity.domain,
        value: identity.value,
        ttl: 3600,
      };
      const merged = { ...existing, ...updates };
      const params = buildUpdateParams(identity.domain, existing, updates);
      const raw = await this.client.updateRecord(identity.domain, params);
      const { zone } = await this.client.getRecords(domain);
      return mapRecord(raw, zone.name);
    } catch (err) {
      throw new DnsOperationError('Failed to update DNS record', err);
    }
  }

  async deleteRecord(domain: string, id: string): Promise<void> {
    try {
      const identity = decodeId(id);
      const record: DnsRecord = {
        id,
        type: identity.type as DnsRecord['type'],
        name: identity.domain,
        value: identity.value,
        ttl: 0,
      };
      const params = buildDeleteParams(identity.domain, record);
      await this.client.deleteRecord(identity.domain, params);
    } catch (err) {
      throw new DnsOperationError('Failed to delete DNS record', err);
    }
  }

  async listZones(): Promise<DnsZone[]> {
    try {
      const zones = await this.client.listZones();
      return zones.map((z) => ({ name: z.name, disabled: z.disabled, internal: z.internal }));
    } catch (err) {
      throw new DnsOperationError('Failed to list DNS zones', err);
    }
  }

  async createZone(name: string): Promise<void> {
    try {
      await this.client.createZone(name);
    } catch (err) {
      throw new DnsOperationError('Failed to create DNS zone', err);
    }
  }

  async deleteZone(name: string): Promise<void> {
    try {
      await this.client.deleteZone(name);
    } catch (err) {
      throw new DnsOperationError('Failed to delete DNS zone', err);
    }
  }
}
