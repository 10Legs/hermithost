import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DATA_DIR = process.env.STATS_DATA_DIR ?? '/app/data';
const DB_PATH = path.join(DATA_DIR, 'stats.db');

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.exec(`
    CREATE TABLE IF NOT EXISTS site_stats_rollup (
      router_name TEXT NOT NULL,
      bucket_ts   INTEGER NOT NULL,
      requests    INTEGER NOT NULL DEFAULT 0,
      human_reqs  INTEGER NOT NULL DEFAULT 0,
      bot_reqs    INTEGER NOT NULL DEFAULT 0,
      unique_ips  INTEGER NOT NULL DEFAULT 0,
      bytes_in    INTEGER NOT NULL DEFAULT 0,
      bytes_out   INTEGER NOT NULL DEFAULT 0,
      sum_ms      REAL    NOT NULL DEFAULT 0,
      status_2xx  INTEGER NOT NULL DEFAULT 0,
      status_4xx  INTEGER NOT NULL DEFAULT 0,
      status_5xx  INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (router_name, bucket_ts)
    );

    CREATE TABLE IF NOT EXISTS ingest_cursor (
      id           INTEGER PRIMARY KEY CHECK (id = 1),
      file_offset  INTEGER NOT NULL DEFAULT 0
    );
    INSERT OR IGNORE INTO ingest_cursor (id, file_offset) VALUES (1, 0);

    CREATE TABLE IF NOT EXISTS page_stats_rollup (
      router_name  TEXT    NOT NULL,
      bucket_ts    INTEGER NOT NULL,
      path         TEXT    NOT NULL,
      requests     INTEGER NOT NULL DEFAULT 0,
      human_reqs   INTEGER NOT NULL DEFAULT 0,
      bot_reqs     INTEGER NOT NULL DEFAULT 0,
      bytes_out    INTEGER NOT NULL DEFAULT 0,
      sum_ms       REAL    NOT NULL DEFAULT 0,
      status_2xx   INTEGER NOT NULL DEFAULT 0,
      status_4xx   INTEGER NOT NULL DEFAULT 0,
      status_5xx   INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (router_name, bucket_ts, path)
    );
    CREATE INDEX IF NOT EXISTS idx_page_stats_router_bucket
      ON page_stats_rollup (router_name, bucket_ts DESC);

    CREATE TABLE IF NOT EXISTS referrer_stats_rollup (
      router_name     TEXT    NOT NULL,
      bucket_ts       INTEGER NOT NULL,
      referrer_domain TEXT    NOT NULL,
      requests        INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (router_name, bucket_ts, referrer_domain)
    );
    CREATE INDEX IF NOT EXISTS idx_referrer_stats_router_bucket
      ON referrer_stats_rollup (router_name, bucket_ts DESC);
  `);
  return _db;
}

// ── Bucket helpers ────────────────────────────────────────────────────────────
const BUCKET_SECS = 900; // 15 minutes

export function toBucket(unixSecs: number): number {
  return Math.floor(unixSecs / BUCKET_SECS) * BUCKET_SECS;
}

// ── Write a batch of rollup increments ───────────────────────────────────────
export interface RollupIncrement {
  router_name: string;
  bucket_ts: number;
  requests: number;
  human_reqs: number;
  bot_reqs: number;
  unique_ips: number;
  bytes_in: number;
  bytes_out: number;
  sum_ms: number;
  status_2xx: number;
  status_4xx: number;
  status_5xx: number;
}

const upsertStmt = (db: Database.Database) => db.prepare(`
  INSERT INTO site_stats_rollup
    (router_name, bucket_ts, requests, human_reqs, bot_reqs, unique_ips,
     bytes_in, bytes_out, sum_ms, status_2xx, status_4xx, status_5xx)
  VALUES
    (@router_name, @bucket_ts, @requests, @human_reqs, @bot_reqs, @unique_ips,
     @bytes_in, @bytes_out, @sum_ms, @status_2xx, @status_4xx, @status_5xx)
  ON CONFLICT(router_name, bucket_ts) DO UPDATE SET
    requests   = requests   + excluded.requests,
    human_reqs = human_reqs + excluded.human_reqs,
    bot_reqs   = bot_reqs   + excluded.bot_reqs,
    unique_ips = unique_ips + excluded.unique_ips,
    bytes_in   = bytes_in   + excluded.bytes_in,
    bytes_out  = bytes_out  + excluded.bytes_out,
    sum_ms     = sum_ms     + excluded.sum_ms,
    status_2xx = status_2xx + excluded.status_2xx,
    status_4xx = status_4xx + excluded.status_4xx,
    status_5xx = status_5xx + excluded.status_5xx
`);

export function writeRollups(increments: RollupIncrement[], newOffset: number): void {
  const db = getDb();
  const upsert = upsertStmt(db);
  const tx = db.transaction(() => {
    for (const row of increments) {
      upsert.run(row);
    }
    db.prepare('UPDATE ingest_cursor SET file_offset = ? WHERE id = 1').run(newOffset);
  });
  tx();
}

export function getCursor(): number {
  return (getDb().prepare('SELECT file_offset FROM ingest_cursor WHERE id = 1').get() as { file_offset: number } | undefined)?.file_offset ?? 0;
}

// ── Query helpers ─────────────────────────────────────────────────────────────
export type StatRange = '24h' | '7d' | '30d';

const RANGE_SECS: Record<StatRange, number> = {
  '24h': 86400,
  '7d':  604800,
  '30d': 2592000,
};

export interface SiteStatsResult {
  range: StatRange;
  requests: number;
  human_requests: number;
  bot_requests: number;
  bandwidth_bytes: number;
  error_rate: number;
  avg_ms: number | null;
  sparkline: Array<{ ts: number; requests: number }>;
}

export function querySiteStats(routerName: string, range: StatRange): SiteStatsResult {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const since = now - RANGE_SECS[range];

  const agg = db.prepare(`
    SELECT
      SUM(requests)   AS requests,
      SUM(human_reqs) AS human_reqs,
      SUM(bot_reqs)   AS bot_reqs,
      SUM(bytes_out)  AS bytes_out,
      SUM(status_4xx) + SUM(status_5xx) AS errors,
      SUM(sum_ms)     AS sum_ms
    FROM site_stats_rollup
    WHERE router_name = ? AND bucket_ts >= ?
  `).get(routerName, toBucket(since)) as {
    requests: number | null;
    human_reqs: number | null;
    bot_reqs: number | null;
    bytes_out: number | null;
    errors: number | null;
    sum_ms: number | null;
  } | undefined;

  const requests = agg?.requests ?? 0;
  const human_requests = agg?.human_reqs ?? 0;
  const bot_requests = agg?.bot_reqs ?? 0;
  const bandwidth_bytes = agg?.bytes_out ?? 0;
  const errors = agg?.errors ?? 0;
  const sum_ms = agg?.sum_ms ?? 0;

  const error_rate = requests > 0 ? errors / requests : 0;
  const avg_ms = requests > 0 ? sum_ms / requests : null;

  // Sparkline: for 24h → hourly buckets (4 per hour × 24 = 96 points)
  //            for 7d  → 6h buckets  (4 per day × 7  = 28 points)
  //            for 30d → daily buckets (1 per day × 30 = 30 points)
  const sparkBucketSecs = range === '24h' ? 3600 : range === '7d' ? 21600 : 86400;

  const sparkRows = db.prepare(`
    SELECT
      (bucket_ts / ?) * ? AS spark_ts,
      SUM(requests) AS requests
    FROM site_stats_rollup
    WHERE router_name = ? AND bucket_ts >= ?
    GROUP BY spark_ts
    ORDER BY spark_ts ASC
  `).all(sparkBucketSecs, sparkBucketSecs, routerName, toBucket(since)) as Array<{ spark_ts: number; requests: number }>;

  return {
    range,
    requests,
    human_requests,
    bot_requests,
    bandwidth_bytes,
    error_rate,
    avg_ms,
    sparkline: sparkRows.map(r => ({ ts: r.spark_ts, requests: r.requests })),
  };
}

// 96 × 15-min buckets = 24h for pulse strip
export interface PulseBucket {
  ts: number;
  requests: number;
}

export function queryPulse(routerName: string): { buckets: PulseBucket[]; max_requests: number } {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const since = now - 86400;

  const rows = db.prepare(`
    SELECT bucket_ts AS ts, requests
    FROM site_stats_rollup
    WHERE router_name = ? AND bucket_ts >= ?
    ORDER BY bucket_ts ASC
  `).all(routerName, toBucket(since)) as Array<{ ts: number; requests: number }>;

  const max_requests = rows.reduce((m, r) => Math.max(m, r.requests), 0);
  return { buckets: rows, max_requests };
}

// ── Page-level stats ──────────────────────────────────────────────────────────

export interface PageRollupIncrement {
  router_name: string;
  bucket_ts: number;
  path: string;
  requests: number;
  human_reqs: number;
  bot_reqs: number;
  bytes_out: number;
  sum_ms: number;
  status_2xx: number;
  status_4xx: number;
  status_5xx: number;
}

export function writePageRollups(
  pages: PageRollupIncrement[],
  refs: Array<{ router_name: string; bucket_ts: number; referrer_domain: string; requests: number }>
): void {
  const db = getDb();
  const upsertPage = db.prepare(`
    INSERT INTO page_stats_rollup
      (router_name, bucket_ts, path, requests, human_reqs, bot_reqs, bytes_out, sum_ms, status_2xx, status_4xx, status_5xx)
    VALUES
      (@router_name, @bucket_ts, @path, @requests, @human_reqs, @bot_reqs, @bytes_out, @sum_ms, @status_2xx, @status_4xx, @status_5xx)
    ON CONFLICT(router_name, bucket_ts, path) DO UPDATE SET
      requests   = requests   + excluded.requests,
      human_reqs = human_reqs + excluded.human_reqs,
      bot_reqs   = bot_reqs   + excluded.bot_reqs,
      bytes_out  = bytes_out  + excluded.bytes_out,
      sum_ms     = sum_ms     + excluded.sum_ms,
      status_2xx = status_2xx + excluded.status_2xx,
      status_4xx = status_4xx + excluded.status_4xx,
      status_5xx = status_5xx + excluded.status_5xx
  `);
  const upsertRef = db.prepare(`
    INSERT INTO referrer_stats_rollup (router_name, bucket_ts, referrer_domain, requests)
    VALUES (@router_name, @bucket_ts, @referrer_domain, @requests)
    ON CONFLICT(router_name, bucket_ts, referrer_domain) DO UPDATE SET
      requests = requests + excluded.requests
  `);
  db.transaction(() => {
    for (const p of pages) upsertPage.run(p);
    for (const r of refs) upsertRef.run(r);
  })();
}

export interface TopPage {
  path: string;
  requests: number;
  human_requests: number;
  avg_ms: number | null;
  error_rate: number;
  trend: number | null; // % change vs. prior period; null if no prior data
}

export interface PageStatsResult {
  range: StatRange;
  top_pages: TopPage[];
  top_referrers: Array<{ referrer_domain: string; requests: number }>;
}

export function queryPageStats(routerName: string, range: StatRange, limit = 25): PageStatsResult {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const since = toBucket(now - RANGE_SECS[range]);
  const prevSince = toBucket(now - RANGE_SECS[range] * 2);

  const pages = db.prepare(`
    SELECT path,
           SUM(requests)   AS requests,
           SUM(human_reqs) AS human_requests,
           SUM(sum_ms)     AS sum_ms,
           SUM(status_4xx) + SUM(status_5xx) AS errors
    FROM page_stats_rollup
    WHERE router_name = ? AND bucket_ts >= ?
    GROUP BY path
    ORDER BY requests DESC
    LIMIT ?
  `).all(routerName, since, limit) as Array<{
    path: string; requests: number; human_requests: number; sum_ms: number; errors: number;
  }>;

  // Prior period for trend computation
  const prevPages = db.prepare(`
    SELECT path, SUM(requests) AS requests
    FROM page_stats_rollup
    WHERE router_name = ? AND bucket_ts >= ? AND bucket_ts < ?
    GROUP BY path
  `).all(routerName, prevSince, since) as Array<{ path: string; requests: number }>;
  const prevMap = new Map(prevPages.map(r => [r.path, r.requests]));

  const refs = db.prepare(`
    SELECT referrer_domain, SUM(requests) AS requests
    FROM referrer_stats_rollup
    WHERE router_name = ? AND bucket_ts >= ?
    GROUP BY referrer_domain
    ORDER BY requests DESC
    LIMIT 20
  `).all(routerName, since) as Array<{ referrer_domain: string; requests: number }>;

  return {
    range,
    top_pages: pages.map(r => {
      const prev = prevMap.get(r.path) ?? 0;
      const trend = prev > 0 ? Math.round(((r.requests - prev) / prev) * 100) : null;
      return {
        path: r.path,
        requests: r.requests,
        human_requests: r.human_requests,
        avg_ms: r.requests > 0 ? r.sum_ms / r.requests : null,
        error_rate: r.requests > 0 ? r.errors / r.requests : 0,
        trend,
      };
    }),
    top_referrers: refs,
  };
}

export function pruneOldPageStats(): void {
  const db = getDb();
  const cutoff = Math.floor(Date.now() / 1000) - 90 * 86400;
  db.prepare('DELETE FROM page_stats_rollup WHERE bucket_ts < ?').run(cutoff);
  db.prepare('DELETE FROM referrer_stats_rollup WHERE bucket_ts < ?').run(cutoff);
}
