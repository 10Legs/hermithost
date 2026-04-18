import { Router, Request, Response } from 'express';
import { exportBackup, validateBackup, importBackup, BackupFile, ExportFilter } from '../services/backup';

const router = Router();

// "name1,name2" → ['name1','name2']
// "all"         → undefined (= all)
// absent + other param present → []
function parseSelectionParam(raw: string | undefined, anyOtherParamPresent: boolean): string[] | undefined {
  if (raw === undefined) {
    return anyOtherParamPresent ? [] : undefined;
  }
  if (raw === 'all') return undefined;
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

function resolveFilename(filter: ExportFilter | undefined, date: string): string {
  if (!filter) return `hermithost-backup-${date}.json`;
  // undefined = all (user wants all), [] = none (user excluded all), [...] = subset
  const wantsSites = !Array.isArray(filter.sites) || filter.sites.length > 0;
  const wantsZones = !Array.isArray(filter.zones) || filter.zones.length > 0;
  if (wantsSites && wantsZones) return `hermithost-backup-${date}.json`;
  if (wantsSites && !wantsZones) return `hermithost-sites-${date}.json`;
  if (!wantsSites && wantsZones) return `hermithost-dns-${date}.json`;
  return `hermithost-partial-${date}.json`;
}

// GET /api/backup — export state as downloadable JSON
// Query params: sites, zones (optional — absent = full backup for backward compat)
router.get('/', async (req: Request, res: Response) => {
  try {
    const rawSites = req.query.sites as string | undefined;
    const rawZones = req.query.zones as string | undefined;
    const hasAnyParam = rawSites !== undefined || rawZones !== undefined;

    let filter: ExportFilter | undefined;
    if (hasAnyParam) {
      filter = {
        sites: parseSelectionParam(rawSites, rawZones !== undefined),
        zones: parseSelectionParam(rawZones, rawSites !== undefined),
      };
    }

    const backup = await exportBackup(filter);
    const date = new Date().toISOString().slice(0, 10);
    const filename = resolveFilename(filter, date);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.status(200).json(backup);
  } catch (err) {
    console.error('[backup] export failed:', (err as Error).message);
    res.status(500).json({ error: 'Failed to export backup' });
  }
});

// POST /api/backup/validate — validate without importing
router.post('/validate', async (req: Request, res: Response) => {
  try {
    const result = await validateBackup(req.body);
    res.status(200).json(result);
  } catch (err) {
    console.error('[backup] validate failed:', (err as Error).message);
    res.status(500).json({ error: 'Validation failed' });
  }
});

// POST /api/backup — import (restore)
router.post('/', async (req: Request, res: Response) => {
  try {
    const validation = await validateBackup(req.body);
    if (!validation.valid) {
      res.status(422).json({ error: 'Invalid backup file', errors: validation.errors });
      return;
    }
    const result = await importBackup(req.body as BackupFile);
    res.status(200).json(result);
  } catch (err) {
    console.error('[backup] import failed:', (err as Error).message);
    res.status(500).json({ error: 'Failed to import backup' });
  }
});

export default router;
