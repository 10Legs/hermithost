import fs from 'fs';
import { getCursor, writeRollups, writePageRollups, pruneOldPageStats, toBucket, RollupIncrement, PageRollupIncrement } from './stats';

const LOG_PATH = process.env.TRAEFIK_LOG_PATH ?? '/traefik-logs/traefik-access.log';
const INTERVAL_MS = Number(process.env.STATS_INGEST_INTERVAL_MS ?? 5_000);

// ── Bot UA patterns ───────────────────────────────────────────────────────────
const BOT_PATTERNS = [
  /bot/i, /crawl/i, /spider/i, /slurp/i, /scrape/i,
  /googlebot/i, /bingbot/i, /yandex/i, /baidu/i, /duckduckbot/i,
  /facebookexternalhit/i, /twitterbot/i, /linkedinbot/i, /whatsapp/i,
  /curl\//i, /wget\//i, /python-requests/i, /go-http-client/i,
  /axios\//i, /libwww-perl/i, /java\//i, /jakarta/i,
  /semrush/i, /ahrefs/i, /mj12bot/i, /dotbot/i, /petalbot/i,
];

function isBot(ua: string): boolean {
  for (const pat of BOT_PATTERNS) {
    if (pat.test(ua)) return true;
  }
  return false;
}

// ── Router name → slug ────────────────────────────────────────────────────────
// Traefik appends @file or @docker to router names.
// Routes provisioned by HermitHost follow the pattern: site-{slug}
function normalizeRouterName(raw: string): string | null {
  // Strip provider suffix: "site-myapp@file" → "site-myapp"
  const name = raw.replace(/@\w+$/, '');
  // Skip HTTP redirect routers
  if (name.endsWith('-http')) return null;
  // Only handle hermithost-provisioned site routes
  if (!name.startsWith('site-')) return null;
  return name; // keep as "site-{slug}" — used as the router_name key
}

// ── Traefik JSON log entry ────────────────────────────────────────────────────
interface TraefikLogEntry {
  RouterName?: string;
  ClientHost?: string;
  RequestMethod?: string;
  DownstreamStatus?: number;
  Duration?: number;          // nanoseconds
  DownstreamContentSize?: number;
  RequestContentSize?: number;
  StartUTC?: string;
  'request_User-Agent'?: string;
  RequestPath?: string;
  'request_Referer'?: string;
}

function normalizePath(raw: string): string {
  if (!raw) return '/';
  return (raw.split('?')[0].substring(0, 512).replace(/\/+/g, '/')) || '/';
}

function extractReferrerDomain(referer: string): string {
  if (!referer) return '';
  try { return new URL(referer).hostname.toLowerCase(); } catch { return ''; }
}

// ── Main ingest function ──────────────────────────────────────────────────────
function ingest(): void {
  if (!fs.existsSync(LOG_PATH)) return;

  let stat: fs.Stats;
  try {
    stat = fs.statSync(LOG_PATH);
  } catch {
    return;
  }

  const cursor = getCursor();

  // Log was rotated — reset cursor
  const offset = stat.size < cursor ? 0 : cursor;
  if (stat.size === offset) return; // nothing new

  const fd = fs.openSync(LOG_PATH, 'r');
  const bufSize = Math.min(stat.size - offset, 8 * 1024 * 1024); // read up to 8MB per run
  const buf = Buffer.allocUnsafe(bufSize);
  const bytesRead = fs.readSync(fd, buf, 0, bufSize, offset);
  fs.closeSync(fd);

  if (bytesRead === 0) return;

  const newOffset = offset + bytesRead;
  const text = buf.subarray(0, bytesRead).toString('utf8');
  const lines = text.split('\n');

  // Accumulate per (router_name, bucket_ts) → increments
  // Track unique IPs per bucket per router using Sets
  type BucketKey = string; // `${routerName}|${bucketTs}`
  const acc = new Map<BucketKey, Omit<RollupIncrement, 'unique_ips'> & { ips: Set<string> }>();
  const pageAcc = new Map<string, PageRollupIncrement>();
  const refAcc = new Map<string, { router_name: string; bucket_ts: number; referrer_domain: string; requests: number }>();

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let entry: TraefikLogEntry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }

    const routerRaw = entry.RouterName ?? '';
    const routerName = normalizeRouterName(routerRaw);
    if (!routerName) continue;

    const ua = entry['request_User-Agent'] ?? '';
    const bot = isBot(ua);
    const status = entry.DownstreamStatus ?? 0;
    const durationMs = (entry.Duration ?? 0) / 1_000_000; // ns → ms
    const bytesOut = entry.DownstreamContentSize ?? 0;
    const bytesIn = entry.RequestContentSize ?? 0;
    const clientIp = entry.ClientHost ?? '';

    // Parse timestamp
    let ts: number;
    if (entry.StartUTC) {
      ts = Math.floor(new Date(entry.StartUTC).getTime() / 1000);
    } else {
      ts = Math.floor(Date.now() / 1000);
    }
    const bucket = toBucket(ts);
    if (isNaN(bucket)) continue;

    const key: BucketKey = `${routerName}|${bucket}`;
    let row = acc.get(key);
    if (!row) {
      row = {
        router_name: routerName,
        bucket_ts: bucket,
        requests: 0,
        human_reqs: 0,
        bot_reqs: 0,
        bytes_in: 0,
        bytes_out: 0,
        sum_ms: 0,
        status_2xx: 0,
        status_4xx: 0,
        status_5xx: 0,
        ips: new Set(),
      };
      acc.set(key, row);
    }

    row.requests++;
    if (bot) row.bot_reqs++; else row.human_reqs++;
    row.bytes_in += bytesIn;
    row.bytes_out += bytesOut;
    row.sum_ms += durationMs;
    if (status >= 200 && status < 300) row.status_2xx++;
    else if (status >= 400 && status < 500) row.status_4xx++;
    else if (status >= 500) row.status_5xx++;
    if (clientIp) row.ips.add(clientIp);

    // Page-level accumulation
    const path = normalizePath(entry.RequestPath ?? '');
    const pageKey = `${routerName}|${bucket}|${path}`;
    let pr = pageAcc.get(pageKey);
    if (!pr) {
      pr = { router_name: routerName, bucket_ts: bucket, path, requests: 0, human_reqs: 0, bot_reqs: 0, bytes_out: 0, sum_ms: 0, status_2xx: 0, status_4xx: 0, status_5xx: 0 };
      pageAcc.set(pageKey, pr);
    }
    pr.requests++;
    if (bot) pr.bot_reqs++; else pr.human_reqs++;
    pr.bytes_out += bytesOut;
    pr.sum_ms += durationMs;
    if (status >= 200 && status < 300) pr.status_2xx++;
    else if (status >= 400 && status < 500) pr.status_4xx++;
    else if (status >= 500) pr.status_5xx++;

    // Referrer accumulation
    const refDomain = extractReferrerDomain(entry['request_Referer'] ?? '');
    const refKey = `${routerName}|${bucket}|${refDomain}`;
    const rr = refAcc.get(refKey) ?? { router_name: routerName, bucket_ts: bucket, referrer_domain: refDomain, requests: 0 };
    rr.requests++;
    refAcc.set(refKey, rr);
  }

  if (acc.size === 0) {
    // Advance cursor even if no valid entries (skip bad log lines)
    writeRollups([], newOffset);
    return;
  }

  const increments: RollupIncrement[] = [];
  for (const [, row] of acc) {
    const { ips, ...rest } = row;
    increments.push({ ...rest, unique_ips: ips.size });
  }

  writeRollups(increments, newOffset);
  if (pageAcc.size > 0) writePageRollups([...pageAcc.values()], [...refAcc.values()]);
  console.log(`[stats-ingest] ${increments.length} bucket(s) updated, ${pageAcc.size} page path(s), offset=${newOffset}`);
}

// ── Start ─────────────────────────────────────────────────────────────────────
export function startStatsIngester(): void {
  console.log(`[stats-ingest] Starting — log=${LOG_PATH}, interval=${INTERVAL_MS}ms`);
  // Run immediately on start, then on interval
  try { ingest(); } catch (err) {
    console.warn('[stats-ingest] Initial ingest error:', (err as Error).message);
  }
  setInterval(() => {
    try { ingest(); } catch (err) {
      console.warn('[stats-ingest] Ingest error:', (err as Error).message);
    }
  }, INTERVAL_MS);
  // Prune page stats older than 90 days, once per hour
  setInterval(() => { try { pruneOldPageStats(); } catch {} }, 3_600_000);
}
