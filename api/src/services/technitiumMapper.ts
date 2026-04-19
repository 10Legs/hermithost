// Maps Technitium raw API types → HermitHost internal DnsRecord type.

import type { TechnitiumRecord } from './technitium';
import type { DnsRecord, DnsRecordType } from '../types';

// ── ID encoding ───────────────────────────────────────────────────────────────
// Technitium has no record UUIDs; encode {domain, type, value} as base64url
// so delete/update can recover the identity params from just the ID.

interface RecordIdentity {
  domain: string;
  type: string;
  value: string;
}

export function encodeId(identity: RecordIdentity): string {
  return Buffer.from(JSON.stringify(identity)).toString('base64url');
}

export function decodeId(id: string): RecordIdentity {
  try {
    const json = Buffer.from(id, 'base64url').toString('utf8');
    return JSON.parse(json) as RecordIdentity;
  } catch {
    throw new Error(`Invalid DNS record ID: ${id}`);
  }
}

// ── Name normalization ────────────────────────────────────────────────────────
// Strip the zone suffix from the record name to get a relative name.
// If name equals zone name exactly, return '@' (apex).

function normalizeRecordName(recordName: string, zoneName: string): string {
  if (recordName === zoneName) return '@';
  const suffix = `.${zoneName}`;
  if (recordName.endsWith(suffix)) {
    return recordName.slice(0, -suffix.length);
  }
  return recordName;
}

// ── Value extraction from rData ───────────────────────────────────────────────

function extractValue(raw: TechnitiumRecord): string {
  const r = raw.rData;
  switch (raw.type) {
    case 'A':
    case 'AAAA':
      return r.ipAddress ?? '';
    case 'CNAME':
      return r.cname ?? '';
    case 'MX':
      return r.exchange ?? '';
    case 'TXT':
      return r.text ?? '';
    case 'NS':
      return r.nameServer ?? '';
    case 'SRV':
      return r.target ?? '';
    case 'SOA':
      return r.primaryNameServer ?? '';
    case 'CAA':
      return r.value ?? `${r.flags ?? 0} ${r.tag ?? ''} ""`;
    case 'PTR':
      return r.ptrdname ?? '';
    default:
      return '';
  }
}

// ── Supported record type guard ───────────────────────────────────────────────

const SUPPORTED_TYPES: ReadonlySet<string> = new Set([
  'A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SRV', 'SOA', 'CAA', 'PTR',
]);

function isSupportedType(type: string): type is DnsRecordType {
  return SUPPORTED_TYPES.has(type);
}

// ── Filter predicate ──────────────────────────────────────────────────────────

export function shouldIncludeRecord(raw: TechnitiumRecord, zoneName: string): boolean {
  if (raw.disabled) return false;
  if (!isSupportedType(raw.type)) return false;
  return true;
}

// ── Record mapper ─────────────────────────────────────────────────────────────

export function mapRecord(raw: TechnitiumRecord, zoneName: string): DnsRecord {
  const value = extractValue(raw);
  const identity: RecordIdentity = { domain: raw.name, type: raw.type, value };
  const id = encodeId(identity);
  const name = normalizeRecordName(raw.name, zoneName);

  const record: DnsRecord = {
    id,
    type: raw.type as DnsRecordType,
    name,
    value,
    ttl: raw.rData.ipAddress !== undefined || raw.type === 'A' || raw.type === 'AAAA'
      ? raw.ttl
      : raw.ttl,
  };

  // Priority: MX uses rData.preference; SRV uses rData.priority
  if (raw.type === 'MX' && raw.rData.preference !== undefined) {
    record.priority = raw.rData.preference;
  } else if (raw.type === 'SRV' && raw.rData.priority !== undefined) {
    record.priority = raw.rData.priority;
  }

  return record;
}

// ── Add params builder ────────────────────────────────────────────────────────

export function buildAddParams(domain: string, record: DnsRecord): URLSearchParams {
  const params = new URLSearchParams();
  params.set('domain', domain);
  params.set('type', record.type);
  params.set('ttl', String(record.ttl));

  switch (record.type) {
    case 'A':
    case 'AAAA':
      params.set('ipAddress', record.value);
      break;
    case 'CNAME':
      params.set('cName', record.value);
      break;
    case 'MX':
      params.set('exchange', record.value);
      params.set('preference', String(record.priority ?? 10));
      break;
    case 'TXT':
      params.set('text', record.value);
      break;
    case 'NS':
      params.set('nameServer', record.value);
      break;
    case 'SRV':
      // SRV value is target; caller must supply priority/weight/port separately
      // via record fields — priority is on the record, weight/port are not modeled
      // in DnsRecord so we default them to 0
      params.set('target', record.value);
      params.set('priority', String(record.priority ?? 0));
      params.set('weight', '0');
      params.set('port', '0');
      break;
    case 'CAA':
      params.set('flags', String(record.priority ?? 0));
      params.set('tag', 'issue');  // default tag; value contains the actual issuer
      params.set('value', record.value);
      break;
    case 'PTR':
      params.set('ptrdname', record.value);
      break;
  }

  return params;
}

// ── Update params builder ─────────────────────────────────────────────────────

export function buildUpdateParams(
  domain: string,
  existing: DnsRecord,
  updates: Partial<DnsRecord>
): URLSearchParams {
  const params = new URLSearchParams();
  params.set('domain', domain);
  params.set('type', existing.type);
  params.set('ttl', String(updates.ttl ?? existing.ttl));

  switch (existing.type) {
    case 'A':
    case 'AAAA':
      params.set('ipAddress', existing.value);
      params.set('newIpAddress', updates.value ?? existing.value);
      break;
    case 'CNAME':
      params.set('cName', existing.value);
      params.set('newCname', updates.value ?? existing.value);
      break;
    case 'MX':
      params.set('preference', String(existing.priority ?? 10));
      params.set('exchange', existing.value);
      params.set('newPreference', String(updates.priority ?? existing.priority ?? 10));
      params.set('newExchange', updates.value ?? existing.value);
      break;
    case 'TXT':
      params.set('text', existing.value);
      params.set('newText', updates.value ?? existing.value);
      break;
    case 'NS':
      params.set('nameServer', existing.value);
      params.set('newNameServer', updates.value ?? existing.value);
      break;
    case 'SRV':
      params.set('target', existing.value);
      params.set('priority', String(existing.priority ?? 0));
      params.set('newTarget', updates.value ?? existing.value);
      params.set('newPriority', String(updates.priority ?? existing.priority ?? 0));
      break;
  }

  return params;
}

// ── Delete params builder ─────────────────────────────────────────────────────

export function buildDeleteParams(domain: string, record: DnsRecord): URLSearchParams {
  const params = new URLSearchParams();
  params.set('domain', domain);
  params.set('type', record.type);

  switch (record.type) {
    case 'A':
    case 'AAAA':
      params.set('ipAddress', record.value);
      break;
    case 'CNAME':
      params.set('cName', record.value);
      break;
    case 'MX':
      params.set('preference', String(record.priority ?? 10));
      params.set('exchange', record.value);
      break;
    case 'TXT':
      params.set('text', record.value);
      break;
    case 'NS':
      params.set('nameServer', record.value);
      break;
    case 'SRV':
      params.set('target', record.value);
      params.set('priority', String(record.priority ?? 0));
      break;
    case 'CAA':
      params.set('flags', String(record.priority ?? 0));
      params.set('tag', 'issue');
      params.set('value', record.value);
      break;
    case 'PTR':
      params.set('ptrdname', record.value);
      break;
  }

  return params;
}
