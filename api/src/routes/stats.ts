import { Router, Request, Response } from 'express';
import { querySiteStats, queryPulse, queryPageStats, StatRange } from '../services/stats';
import { liveStatsEmitter, LiveSnapshot } from '../services/liveStats';

const router = Router({ mergeParams: true });

const VALID_RANGES = new Set<StatRange>(['24h', '7d', '30d']);

// ── GET /api/sites/:slug/stats?range=24h|7d|30d ───────────────────────────────
router.get('/', (req: Request, res: Response) => {
  const { slug } = req.params;
  const range = (req.query.range as string) ?? '24h';

  if (!VALID_RANGES.has(range as StatRange)) {
    res.status(400).json({ error: 'range must be one of: 24h, 7d, 30d' });
    return;
  }

  try {
    const routerName = `site-${slug}`;
    const result = querySiteStats(routerName, range as StatRange);
    res.status(200).json(result);
  } catch (err) {
    console.error(`[stats] GET /stats for ${slug} failed:`, (err as Error).message);
    res.status(500).json({ error: 'Failed to query stats' });
  }
});

// ── GET /api/sites/:slug/stats/pulse ─────────────────────────────────────────
// Returns 96 × 15-min buckets for the pulse strip (last 24h)
router.get('/pulse', (req: Request, res: Response) => {
  const { slug } = req.params;

  try {
    const routerName = `site-${slug}`;
    const result = queryPulse(routerName);
    res.status(200).json(result);
  } catch (err) {
    console.error(`[stats] GET /stats/pulse for ${slug} failed:`, (err as Error).message);
    res.status(500).json({ error: 'Failed to query pulse stats' });
  }
});

// ── GET /api/sites/:slug/stats/live — Server-Sent Events ─────────────────────
// Streams live Prometheus-derived stats every 3s.
// Client connects once; server pushes updates until disconnect.
router.get('/live', (req: Request, res: Response) => {
  const { slug } = req.params;
  const routerName = `site-${slug}`;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx/proxy buffering
  res.flushHeaders();

  // Send a keep-alive comment every 20s to prevent proxy timeouts
  const keepAlive = setInterval(() => {
    res.write(': keep-alive\n\n');
  }, 20_000);

  const onSnapshot = (snapshots: LiveSnapshot[]) => {
    const snap = snapshots.find(s => s.routerName === routerName);
    const payload: LiveSnapshot = snap ?? {
      routerName,
      reqPerSec: 0,
      avgLatencyMs: null,
      activeConnections: 0,
      bandwidthOutBps: 0,
      bandwidthInBps: 0,
      ts: Date.now(),
    };
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  liveStatsEmitter.on('snapshot', onSnapshot);

  req.on('close', () => {
    clearInterval(keepAlive);
    liveStatsEmitter.off('snapshot', onSnapshot);
  });
});

// ── GET /api/sites/:slug/stats/pages?range=24h|7d|30d ────────────────────────
router.get('/pages', (req: Request, res: Response) => {
  const { slug } = req.params;
  const range = (req.query.range as string) ?? '24h';

  if (!VALID_RANGES.has(range as StatRange)) {
    res.status(400).json({ error: 'range must be one of: 24h, 7d, 30d' });
    return;
  }

  try {
    const result = queryPageStats(`site-${slug}`, range as StatRange);
    res.status(200).json(result);
  } catch (err) {
    console.error(`[stats] GET /pages for ${slug} failed:`, (err as Error).message);
    res.status(500).json({ error: 'Failed to query page stats' });
  }
});

export default router;
