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
} from '../data/mock';

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

// ── Site mapper ───────────────────────────────────────────────────────────────

export function mapSite(
  app: CoolifyApplication,
  deployments: CoolifyDeploymentQueue[]
): Site {
  const deploys: Deploy[] = deployments.map((d) =>
    mapDeploy(d, app.git_branch)
  );

  const latestDeployment = deployments[0];
  const serverName = latestDeployment?.server_name ?? 'unknown';

  return {
    slug: app.uuid,
    name: app.name,
    domain: primaryDomain(app.fqdn),
    description: app.description ?? '',
    repository: app.git_repository,
    server: serverName,
    overallStatus: mapAppStatus(app.status),
    http: stubHttpStatus(app.status),
    ssl: stubSslStatus(),
    dns: stubDnsStatus(),
    // TODO: populate from Technitium integration
    dnsRecords: [],
    deploys,
  };
}
