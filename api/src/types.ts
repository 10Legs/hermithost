// HermitHost internal type definitions.
// All types mirror the TypeScript interfaces in the frontend src/lib/types.ts exactly.

export type ContainerStatus = 'running' | 'stopped' | 'exited' | 'paused' | 'restarting' | 'dead';
export type ContainerGroup = 'hermithost-stack' | 'deployed-sites';

export interface ServiceContainer {
  id: string;           // 12-char Docker short ID
  name: string;         // container name, leading slash stripped
  image: string;
  status: ContainerStatus;
  state: string;        // raw Docker state
  uptime: string | null;  // Docker "Status" field e.g. "Up 3 hours"
  group: ContainerGroup;
  siteSlug: string | null;  // coolify.name label value
}

export interface ServiceGroup {
  id: string;            // stable identifier for keying
  name: string;          // display name
  domain: string | null; // only set for deployed site groups
  abandoned: boolean;    // true if no matching Coolify application found
  containers: ServiceContainer[];
}

export interface RestoreEvent {
  total: number;
  restored: number;
  failed: string[];  // container names that failed to start
  at: string;        // ISO timestamp
}

export interface ServicesResponse {
  stackGroups: ServiceGroup[];
  siteGroups: ServiceGroup[];
  restoreEvent: RestoreEvent | null;
}

export type SiteStatus = 'healthy' | 'warning' | 'error' | 'pending' | 'disabled';
export type DeployStatus = 'success' | 'failed' | 'running' | 'pending';
export type DnsRecordType = 'A' | 'AAAA' | 'CNAME' | 'MX' | 'TXT' | 'NS' | 'SRV' | 'CAA' | 'SOA' | 'PTR';

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
  deploy_auth: 'ssh_key' | 'pat';
  branch: string;
  build_pack: string;
  docker_compose_location: string;
  base_directory: string;
  http: HttpStatus;
  ssl: SslStatus;
  dns: DnsStatus;
  overallStatus: SiteStatus;
  disabled: boolean;
  dnsRecords: DnsRecord[];
  deploys: Deploy[];
}
