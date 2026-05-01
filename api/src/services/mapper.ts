// Maps Coolify raw API types → HermitHost internal Site and Deploy types.

import type {
  CoolifyApplication,
  CoolifyDeploymentQueue,
  CoolifyLogEntry,
} from './coolify';
import type {
  Site,
  Deploy,
  SiteStatus,
  DeployStatus,
  HttpStatus,
  SslStatus,
  DnsStatus,
} from '../types';
import type { ProbeResult } from './healthProbe';

// ── Status mappers ────────────────────────────────────────────────────────────

function mapAppStatus(coolifyStatus: string): SiteStatus {
  switch (coolifyStatus) {
    case 'running':
      return 'healthy';
    case 'stopped':
    case 'exited':
      return 'warning';
    case 'error':
      return 'error';
    default:
      return 'pending';
  }
}

function mapDeployStatus(coolifyStatus: string): DeployStatus {
  switch (coolifyStatus) {
    case 'finished':
      return 'success';
    case 'failed':
    case 'cancelled-by-user':
      return 'failed';
    case 'in_progress':
      return 'running';
    case 'queued':
      return 'pending';
    default:
      return 'pending';
  }
}

// ── Stub HTTP/SSL/DNS status derived from Coolify app status ──────────────────

function stubHttpStatus(coolifyStatus: string): HttpStatus {
  const running = coolifyStatus === 'running';
  return {
    reachable: running,
    statusCode: running ? 200 : null,
    responseTimeMs: null,
    checkedAt: new Date().toISOString(),
  };
}

function stubSslStatus(): SslStatus {
  return {
    valid: false,
    expiresAt: null,
    daysUntilExpiry: null,
    issuer: null,
    checkedAt: new Date().toISOString(),
  };
}

function stubDnsStatus(): DnsStatus {
  return {
    resolving: false,
    propagated: false,
    checkedAt: new Date().toISOString(),
  };
}

// ── Domain helpers ────────────────────────────────────────────────────────────

function primaryDomain(fqdn: string | null): string {
  if (!fqdn) return '';
  const first = fqdn.split(',')[0].trim();
  // Strip scheme (https:// or http://)
  return first.replace(/^https?:\/\//, '');
}

// ── formatSiteUrl ─────────────────────────────────────────────────────────────
// Reads PUBLIC_BASE_PORT_HTTP / PUBLIC_BASE_PORT_HTTPS from the environment at
// call time so that tests can override process.env between cases.
// When the port equals the scheme's default (80/443) the port is omitted so
// LAN-mode (port-bound to 80/443) renders bare URLs. Internet-mode (8080/8443)
// appends the port. Defaults: HTTPS → 8443, HTTP → 8080 (today's behaviour when
// env is missing, preserving backward compatibility).

const DEFAULT_PORT_HTTPS = 8443;
const DEFAULT_PORT_HTTP = 8080;

// Tracks which env var names have already emitted a bad-value warning so we
// don't spam the log on every request.
const _warnedVars = new Set<string>();

function parsePortEnv(envVal: string | undefined, defaultPort: number, varName: string): number {
  if (!envVal) return defaultPort;
  const trimmed = envVal.trim();
  const n = Number(trimmed);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    if (!_warnedVars.has(varName)) {
      console.warn(`[mapper] ${varName}="${trimmed}" is not a valid port number — falling back to ${defaultPort}`);
      _warnedVars.add(varName);
    }
    return defaultPort;
  }
  return n;
}

export function formatSiteUrl(host: string, scheme: 'http' | 'https'): string {
  const port = scheme === 'https'
    ? parsePortEnv(process.env.PUBLIC_BASE_PORT_HTTPS, DEFAULT_PORT_HTTPS, 'PUBLIC_BASE_PORT_HTTPS')
    : parsePortEnv(process.env.PUBLIC_BASE_PORT_HTTP,  DEFAULT_PORT_HTTP,  'PUBLIC_BASE_PORT_HTTP');
  const schemeDefault = scheme === 'https' ? 443 : 80;
  if (port === schemeDefault) {
    return `${scheme}://${host}`;
  }
  return `${scheme}://${host}:${port}`;
}

// For dockercompose apps Coolify's fqdn column stays as the sslip.io creation-time
// placeholder because PATCH { domains } is rejected (v4.3.5 API constraint).
// The authoritative domain is in docker_compose_domains — pick the first service's domain.
//
// NOTE: Coolify's REST API serialises docker_compose_domains as a JSON STRING even though
// the DB column stores an object. We must JSON.parse it when it arrives as a string.
function parseDockerComposeDomains(raw: string | Record<string, { domain: string }> | null | undefined): Record<string, { domain: string }> | null {
  if (!raw) return null;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as Record<string, { domain: string }>;
    } catch {
      return null;
    }
  }
  return raw;
}

function resolveDisplayDomain(app: CoolifyApplication): string {
  if (app.build_pack === 'dockercompose' && app.docker_compose_domains) {
    const parsed = parseDockerComposeDomains(app.docker_compose_domains);
    if (parsed) {
      const entries = Object.values(parsed);
      if (entries.length > 0 && entries[0].domain) {
        return entries[0].domain.replace(/^https?:\/\//, '');
      }
    }
  }
  return primaryDomain(app.fqdn);
}

// resolveRouteDomain: same field precedence as resolveDisplayDomain — for
// dockercompose apps docker_compose_domains is the authoritative source because
// app.fqdn is frozen to the sslip.io placeholder at creation time. Returns null
// when no usable domain can be found so callers can skip Traefik writes safely.
export function resolveRouteDomain(app: CoolifyApplication): string | null {
  if (app.build_pack === 'dockercompose' && app.docker_compose_domains) {
    const parsed = parseDockerComposeDomains(app.docker_compose_domains);
    if (parsed) {
      const entries = Object.values(parsed);
      if (entries.length > 0 && entries[0].domain) {
        return entries[0].domain
          .replace(/^https?:\/\//, '')
          .replace(/\/.*$/, '');
      }
    }
  }
  if (!app.fqdn) return null;
  const host = app.fqdn.split(',')[0].trim()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '');
  return host || null;
}

// ── Log parsing ───────────────────────────────────────────────────────────────

function parseLogLines(logsJson: string): string[] {
  if (!logsJson) return [];
  try {
    const entries = JSON.parse(logsJson) as CoolifyLogEntry[];
    return entries
      .sort((a, b) => a.order - b.order)
      .map((e) => e.output);
  } catch {
    return [];
  }
}

// ── Deploy mapper ─────────────────────────────────────────────────────────────

export function mapDeploy(
  queue: CoolifyDeploymentQueue,
  gitBranch: string
): Deploy {
  const startMs = new Date(queue.created_at).getTime();
  const finishMs = queue.finished_at ? new Date(queue.finished_at).getTime() : null;
  const durationSeconds =
    finishMs !== null && !Number.isNaN(startMs) && !Number.isNaN(finishMs)
      ? Math.round((finishMs - startMs) / 1000)
      : null;

  let triggeredBy: string;
  if (queue.is_api) {
    triggeredBy = 'api';
  } else if (queue.is_webhook) {
    triggeredBy = 'webhook';
  } else {
    triggeredBy = 'manual';
  }

  return {
    id: queue.deployment_uuid,
    status: mapDeployStatus(queue.status),
    commitRef: queue.commit ? queue.commit.substring(0, 7) : '',
    commitMessage: queue.commit_message ?? '',
    branch: gitBranch,
    triggeredBy,
    startedAt: queue.created_at,
    finishedAt: queue.finished_at ?? null,
    durationSeconds,
    logLines: parseLogLines(queue.logs),
  };
}

// ── Deploy auth detection ─────────────────────────────────────────────────────

function detectDeployAuth(
  gitUrl: string,
  privateKeyUuid?: string
): { deployAuth: 'ssh_key' | 'pat'; cleanUrl: string } {
  // private_key_uuid is the authoritative SSH signal — Coolify strips embedded credentials
  // from git_repository URLs before returning them, making URL-based detection unreliable.
  if (privateKeyUuid) {
    return { deployAuth: 'ssh_key', cleanUrl: gitUrl };
  }
  try {
    const url = new URL(gitUrl);
    if (url.username) {
      url.username = '';
      url.password = '';
      return { deployAuth: 'pat', cleanUrl: url.toString() };
    }
  } catch { /* not a URL or SSH format */ }
  return { deployAuth: 'ssh_key', cleanUrl: gitUrl };
}

// ── Site mapper ───────────────────────────────────────────────────────────────

export function mapSite(
  app: CoolifyApplication,
  deployments: CoolifyDeploymentQueue[],
  probe: ProbeResult | null = null
): Site {
  const deploys: Deploy[] = deployments.map((d) =>
    mapDeploy(d, app.git_branch)
  );

  const latestDeployment = deployments[0];
  const serverName = latestDeployment?.server_name ?? 'unknown';

  const http: HttpStatus = probe ? probe.http : stubHttpStatus(app.status);
  const ssl: SslStatus = probe ? probe.ssl : stubSslStatus();
  const dns: DnsStatus = probe ? probe.dns : stubDnsStatus();
  const { deployAuth, cleanUrl } = detectDeployAuth(app.git_repository, app.private_key_uuid);

  return {
    slug: app.uuid,
    name: app.name,
    domain: resolveDisplayDomain(app),
    description: app.description ?? '',
    repository: cleanUrl,
    deploy_auth: deployAuth,
    branch: app.git_branch,
    build_pack: app.build_pack,
    docker_compose_location: app.docker_compose_location ?? '/docker-compose.yml',
    base_directory: app.base_directory ?? '/',
    server: serverName,
    overallStatus: mapAppStatus(app.status),
    disabled: false,
    http,
    ssl,
    dns,
    // TODO: populate from Technitium integration
    dnsRecords: [],
    deploys,
  };
}
