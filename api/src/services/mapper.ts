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
    domain: primaryDomain(app.fqdn),
    description: app.description ?? '',
    repository: cleanUrl,
    deploy_auth: deployAuth,
    branch: app.git_branch,
    build_pack: app.build_pack,
    server: serverName,
    overallStatus: mapAppStatus(app.status),
    http,
    ssl,
    dns,
    // TODO: populate from Technitium integration
    dnsRecords: [],
    deploys,
  };
}
