import { EventEmitter } from 'events';
import http from 'http';

const TRAEFIK_METRICS_URL = process.env.TRAEFIK_METRICS_URL ?? 'http://traefik:8080/metrics';
const SCRAPE_INTERVAL_MS = Number(process.env.LIVE_STATS_INTERVAL_MS ?? 3_000);

export const liveStatsEmitter = new EventEmitter();
liveStatsEmitter.setMaxListeners(200); // support many concurrent SSE clients

export interface LiveSnapshot {
  routerName: string;    // "site-{slug}"
  reqPerSec: number;
  avgLatencyMs: number | null;
  activeConnections: number; // aggregate entrypoint-level gauge
  bandwidthOutBps: number;   // aggregate bytes/sec out
  bandwidthInBps: number;    // aggregate bytes/sec in
  ts: number;
}

// ── Prometheus text format parser ─────────────────────────────────────────────
interface ParsedMetric {
  name: string;
  labels: Record<string, string>;
  value: number;
}

function parsePrometheusText(text: string): ParsedMetric[] {
  const results: ParsedMetric[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    // metric_name{label="val",...} 1234.5 [timestamp]
    const m = trimmed.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)\{([^}]*)\}\s+([\d.e+\-]+(?:NaN|Inf)?)/);
    if (!m) continue;
    const value = parseFloat(m[3]);
    if (isNaN(value)) continue;
    const labels: Record<string, string> = {};
    for (const kv of m[2].split(',')) {
      const eq = kv.indexOf('=');
      if (eq < 0) continue;
      const k = kv.slice(0, eq).trim();
      const v = kv.slice(eq + 1).trim().replace(/^"|"$/g, '');
      labels[k] = v;
    }
    results.push({ name: m[1], labels, value });
  }
  return results;
}

// ── Previous counter values for delta computation ─────────────────────────────
interface CounterState {
  requestsTotal: Map<string, number>;        // key = routerName
  durationSecsTotal: Map<string, number>;    // key = routerName
  bytesSentTotal: number;
  bytesReceivedTotal: number;
  lastTs: number;
}

const prev: CounterState = {
  requestsTotal: new Map(),
  durationSecsTotal: new Map(),
  bytesSentTotal: 0,
  bytesReceivedTotal: 0,
  lastTs: 0,
};

// ── Fetch metrics from Traefik ────────────────────────────────────────────────
function fetchMetrics(): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.get(TRAEFIK_METRICS_URL, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk; });
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.setTimeout(2500, () => { req.destroy(); reject(new Error('metrics fetch timeout')); });
  });
}

// ── Main scrape function ──────────────────────────────────────────────────────
async function scrape(): Promise<void> {
  const now = Date.now();
  let text: string;
  try {
    text = await fetchMetrics();
  } catch {
    // Traefik not reachable — emit zeros and return
    liveStatsEmitter.emit('snapshot', [] as LiveSnapshot[]);
    return;
  }

  const metrics = parsePrometheusText(text);
  const intervalSecs = prev.lastTs > 0 ? (now - prev.lastTs) / 1000 : SCRAPE_INTERVAL_MS / 1000;

  // Aggregate current counter values by router
  const curRequests = new Map<string, number>();
  const curDuration = new Map<string, number>();
  let curBytesSent = 0;
  let curBytesReceived = 0;
  let activeConnections = 0;

  for (const { name, labels, value } of metrics) {
    switch (name) {
      case 'traefik_router_requests_total': {
        const router = labels['router'];
        if (!router) break;
        const existing = curRequests.get(router) ?? 0;
        curRequests.set(router, existing + value);
        break;
      }
      case 'traefik_router_request_duration_seconds_sum': {
        const router = labels['router'];
        if (!router) break;
        const existing = curDuration.get(router) ?? 0;
        curDuration.set(router, existing + value);
        break;
      }
      case 'traefik_entrypoint_responses_bytes_total':
        curBytesSent += value;
        break;
      case 'traefik_entrypoint_requests_bytes_total':
        curBytesReceived += value;
        break;
      case 'traefik_entrypoint_open_connections':
        activeConnections += value;
        break;
    }
  }

  // Compute aggregate bandwidth deltas
  const bandwidthOutBps = prev.lastTs > 0
    ? Math.max(0, (curBytesSent - prev.bytesSentTotal) / intervalSecs)
    : 0;
  const bandwidthInBps = prev.lastTs > 0
    ? Math.max(0, (curBytesReceived - prev.bytesReceivedTotal) / intervalSecs)
    : 0;

  // Build per-router snapshots
  const snapshots: LiveSnapshot[] = [];
  for (const [router, curReqs] of curRequests) {
    // Normalize: "site-myapp@file" → "site-myapp"
    const routerName = router.replace(/@\w+$/, '');
    if (!routerName.startsWith('site-')) continue;

    const prevReqs = prev.requestsTotal.get(router) ?? curReqs;
    const reqDelta = Math.max(0, curReqs - prevReqs);
    const reqPerSec = prev.lastTs > 0 ? reqDelta / intervalSecs : 0;

    const curDur = curDuration.get(router) ?? 0;
    const prevDur = prev.durationSecsTotal.get(router) ?? curDur;
    const durDelta = Math.max(0, curDur - prevDur);
    const avgLatencyMs = reqDelta > 0 ? (durDelta / reqDelta) * 1000 : null;

    snapshots.push({
      routerName,
      reqPerSec,
      avgLatencyMs,
      activeConnections,
      bandwidthOutBps,
      bandwidthInBps,
      ts: now,
    });
  }

  // Update prev state
  prev.requestsTotal = curRequests;
  prev.durationSecsTotal = curDuration;
  prev.bytesSentTotal = curBytesSent;
  prev.bytesReceivedTotal = curBytesReceived;
  prev.lastTs = now;

  liveStatsEmitter.emit('snapshot', snapshots);
}

// ── Start ─────────────────────────────────────────────────────────────────────
export function startLiveStats(): void {
  console.log(`[live-stats] Starting — url=${TRAEFIK_METRICS_URL}, interval=${SCRAPE_INTERVAL_MS}ms`);
  setInterval(async () => {
    try { await scrape(); } catch (err) {
      console.warn('[live-stats] Scrape error:', (err as Error).message);
    }
  }, SCRAPE_INTERVAL_MS);
}
