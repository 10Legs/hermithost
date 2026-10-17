// ── Direct coolify-db access ──────────────────────────────────────────────────
// For data Coolify's REST API doesn't expose — the same approach as
// writeGitRepositoryUrl() in routes/sites.ts.
import type { Client as PgClient } from 'pg';

async function withCoolifyDb<T>(fn: (pg: PgClient) => Promise<T>): Promise<T> {
  const { Client } = require('pg') as typeof import('pg');
  const pg = new Client({
    host: process.env.PGHOST ?? 'coolify-db',
    port: Number(process.env.PGPORT ?? 5432),
    database: process.env.PGDATABASE ?? 'coolify',
    user: process.env.PGUSER ?? 'coolify',
    password: process.env.PGPASSWORD,
    // Never let an unreachable DB hang an API request.
    connectionTimeoutMillis: 5_000,
    statement_timeout: 5_000,
  });
  await pg.connect();
  try {
    return await fn(pg);
  } finally {
    await pg.end();
  }
}

// "Include source commit in build": Coolify passes SOURCE_COMMIT=<sha> to the
// build when enabled (off by default because it busts the Docker layer cache).
export async function readIncludeSourceCommit(appUuid: string): Promise<boolean | null> {
  return withCoolifyDb(async (pg) => {
    const r = await pg.query<{ include_source_commit_in_build: boolean | null }>(
      `SELECT s.include_source_commit_in_build
         FROM application_settings s
         JOIN applications a ON a.id = s.application_id
        WHERE a.uuid = $1`,
      [appUuid],
    );
    return r.rows.length ? Boolean(r.rows[0].include_source_commit_in_build) : null;
  });
}

// Throws if the application has no settings row, so callers never report a
// change that didn't happen.
export async function writeIncludeSourceCommit(appUuid: string, enabled: boolean): Promise<void> {
  await withCoolifyDb(async (pg) => {
    const r = await pg.query(
      `UPDATE application_settings
          SET include_source_commit_in_build = $1, updated_at = NOW()
        WHERE application_id = (SELECT id FROM applications WHERE uuid = $2)`,
      [enabled, appUuid],
    );
    if (r.rowCount !== 1) throw new Error(`no application_settings row for ${appUuid}`);
  });
  console.log(`[coolify-settings] include_source_commit_in_build=${enabled} for app ${appUuid}`);
}

// True only if the deployment exists and belongs to the application. Used to
// keep a site-scoped caller (deploy token) from reading other sites' logs.
export async function deploymentBelongsToApp(deploymentUuid: string, appUuid: string): Promise<boolean> {
  return withCoolifyDb(async (pg) => {
    const r = await pg.query(
      `SELECT 1
         FROM application_deployment_queues q
         JOIN applications a ON a.id::text = q.application_id::text
        WHERE q.deployment_uuid = $1 AND a.uuid = $2
        LIMIT 1`,
      [deploymentUuid, appUuid],
    );
    return r.rows.length > 0;
  });
}
