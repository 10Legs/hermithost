import type { DnsRecord } from '../../types';

export interface DnsZone {
  name: string;
  disabled?: boolean;
  internal?: boolean;
}

export interface DnsProvider {
  // ── Records ────────────────────────────────────────────────────

  /** Fetch all records for a domain. */
  getRecords(domain: string): Promise<DnsRecord[]>;

  /** Add a record. Returns the created record with a stable id. */
  addRecord(domain: string, record: Omit<DnsRecord, 'id'>): Promise<DnsRecord>;

  /** Update an existing record by id. Returns the updated record. */
  updateRecord(domain: string, id: string, updates: Partial<Omit<DnsRecord, 'id'>>): Promise<DnsRecord>;

  /** Delete a record by id. */
  deleteRecord(domain: string, id: string): Promise<void>;

  // ── Zones ──────────────────────────────────────────────────────

  /** List all zones managed by this provider. */
  listZones(): Promise<DnsZone[]>;

  /** Create a new zone. */
  createZone(name: string): Promise<void>;

  /** Delete a zone by name. */
  deleteZone(name: string): Promise<void>;
}
