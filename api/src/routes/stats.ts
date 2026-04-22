import { Router, Request, Response } from 'express';
import { querySiteStats, queryPulse, StatRange } from '../services/stats';

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

export default router;
