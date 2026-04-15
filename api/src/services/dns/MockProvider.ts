import { randomUUID } from 'node:crypto';
import type { DnsProvider } from './DnsProvider';
import type { DnsRecord } from '../../data/mock';
import { SITES } from '../../data/mock';

export class MockProvider implements DnsProvider {
  async getRecords(domain: string): Promise<DnsRecord[]> {
    return this.findSiteByDomain(domain)?.dnsRecords ?? [];
  }

  async addRecord(domain: string, record: Omit<DnsRecord, 'id'>): Promise<DnsRecord> {
    const created: DnsRecord = { id: randomUUID(), ...record };
    const site = this.findSiteByDomain(domain);
    if (site) site.dnsRecords.push(created);
    return created;
  }

  async updateRecord(
    domain: string,
    id: string,
    updates: Partial<Omit<DnsRecord, 'id'>>
  ): Promise<DnsRecord> {
    const site = this.findSiteByDomain(domain);
    if (site) {
      const idx = site.dnsRecords.findIndex((r) => r.id === id);
      if (idx !== -1) {
        site.dnsRecords[idx] = { ...site.dnsRecords[idx], ...updates };
        return site.dnsRecords[idx];
      }
    }
    // Record not found — return a synthetic updated record
    return { id, type: 'A', name: '@', value: '0.0.0.0', ttl: 3600, ...updates } as DnsRecord;
  }

  async deleteRecord(domain: string, id: string): Promise<void> {
    const site = this.findSiteByDomain(domain);
    if (site) {
      const idx = site.dnsRecords.findIndex((r) => r.id === id);
      if (idx !== -1) site.dnsRecords.splice(idx, 1);
    }
  }

  private findSiteByDomain(domain: string) {
    return SITES.find((s) => s.domain === domain);
  }
}
