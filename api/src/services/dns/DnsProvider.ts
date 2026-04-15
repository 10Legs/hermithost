import type { DnsRecord } from '../../data/mock';

export interface DnsProvider {
  /** Fetch all records for a domain. */
  getRecords(domain: string): Promise<DnsRecord[]>;

  /** Add a record. Returns the created record with a stable id. */
  addRecord(domain: string, record: Omit<DnsRecord, 'id'>): Promise<DnsRecord>;

  /** Update an existing record by id. Returns the updated record. */
  updateRecord(domain: string, id: string, updates: Partial<Omit<DnsRecord, 'id'>>): Promise<DnsRecord>;

  /** Delete a record by id. */
  deleteRecord(domain: string, id: string): Promise<void>;
}
