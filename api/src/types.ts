// HermitHost internal type definitions.
// All types mirror the TypeScript interfaces in the frontend src/lib/types.ts exactly.

export type SiteStatus = 'healthy' | 'warning' | 'error' | 'pending';
export type DeployStatus = 'success' | 'failed' | 'running' | 'pending';
export type DnsRecordType = 'A' | 'AAAA' | 'CNAME' | 'MX' | 'TXT' | 'NS' | 'SRV' | 'CAA';

export interface HttpStatus {
  reachable: boolean;
  statusCode: number | null;
  responseTimeMs: number | null;
  checkedAt: string;
}

export interface SslStatus {
  valid: boolean;
  expiresAt: string | null;
  daysUntilExpiry: number | null;
  issuer: string | null;
  checkedAt: string;
}

export interface DnsStatus {
  resolving: boolean;
  propagated: boolean;
  checkedAt: string;
}

export interface DnsRecord {
  id: string;
  type: DnsRecordType;
  name: string;
  value: string;
  ttl: number;
  priority?: number;
}

export interface Deploy {
  id: string;
  status: DeployStatus;
  commitRef: string;
  commitMessage: string;
  branch: string;
  triggeredBy: string;
  startedAt: string;
  finishedAt: string | null;
  durationSeconds: number | null;
  logLines: string[];
}

export interface Site {
  slug: string;
  name: string;
  domain: string;
  description: string;
  repository: string;
  server: string;
  http: HttpStatus;
  ssl: SslStatus;
  dns: DnsStatus;
  overallStatus: SiteStatus;
  dnsRecords: DnsRecord[];
  deploys: Deploy[];
}
