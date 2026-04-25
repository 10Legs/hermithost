export type ContainerStatus = 'running' | 'stopped' | 'exited' | 'paused' | 'restarting' | 'dead';
export type ContainerGroup = 'hermithost-stack' | 'deployed-sites';

export interface ServiceContainer {
	id: string;
	name: string;
	image: string;
	status: ContainerStatus;
	state: string;
	uptime: string | null;
	group: ContainerGroup;
	siteSlug: string | null;
}

export interface ServiceGroup {
	id: string;
	name: string;
	domain: string | null;
	abandoned: boolean;
	containers: ServiceContainer[];
}

export interface RestoreEvent {
	total: number;
	restored: number;
	failed: string[];
	at: string;
}

export interface ServicesResponse {
	stackGroups: ServiceGroup[];
	siteGroups: ServiceGroup[];
	restoreEvent: RestoreEvent | null;
}

export type SiteStatus = 'healthy' | 'warning' | 'error' | 'pending';
export type DeployStatus = 'success' | 'failed' | 'running' | 'pending';
export type DnsRecordType = 'A' | 'AAAA' | 'CNAME' | 'MX' | 'TXT' | 'NS' | 'SRV' | 'SOA' | 'CAA' | 'PTR';

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

export interface EnvVar {
	uuid: string;
	key: string;
	value: string;
	is_shown_once: boolean;
	is_runtime: boolean;
	is_buildtime: boolean;
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
	http: HttpStatus;
	ssl: SslStatus;
	dns: DnsStatus;
	overallStatus: SiteStatus;
	dnsRecords?: DnsRecord[];
	deploys?: Deploy[];
}
