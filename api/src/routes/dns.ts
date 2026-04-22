import { Router, Request, Response } from 'express';
import { DnsRecord } from '../types';
import { createDnsProvider, DnsOperationError } from '../services/dns';

const router = Router();

// ── GET /api/dns/config — nameserver config for UI ────────────────────────────
router.get('/config', (_req: Request, res: Response) => {
  res.status(200).json({ nsHostname: process.env.NS_HOSTNAME ?? null });
});

// ── GET /api/dns/zones — list all zones ───────────────────────────────────────
router.get('/zones', async (_req: Request, res: Response) => {
  try {
    const provider = createDnsProvider();
    const zones = await provider.listZones();
    res.status(200).json(zones.filter((z) => !z.internal && !z.name.endsWith('.arpa')));
  } catch (err) {
    console.error('[dns] GET /zones failed:', (err as Error).message);
    res.status(502).json({ error: 'Failed to retrieve zones from DNS server' });
  }
});

// ── POST /api/dns/zones — create a zone ───────────────────────────────────────
// Body: { name: string }
router.post('/zones', async (req: Request, res: Response) => {
  const body = req.body as { name?: string };
  if (!body.name) {
    res.status(400).json({ error: 'Missing required field: name' });
    return;
  }
  try {
    const provider = createDnsProvider();
    await provider.createZone(body.name);
    res.status(201).json({ name: body.name });
  } catch (err) {
    console.error('[dns] POST /zones failed:', (err as Error).message);
    res.status(502).json({ error: 'Failed to create zone on DNS server' });
  }
});

// ── DELETE /api/dns/zones/:name — delete a zone ───────────────────────────────
router.delete('/zones/:name', async (req: Request, res: Response) => {
  try {
    const provider = createDnsProvider();
    await provider.deleteZone(req.params.name);
    res.status(204).send();
  } catch (err) {
    console.error(`[dns] DELETE /zones/${req.params.name} failed:`, (err as Error).message);
    res.status(502).json({ error: 'Failed to delete zone on DNS server' });
  }
});

// ── GET /api/dns/zones/:name/records — list records in zone ───────────────────
router.get('/zones/:name/records', async (req: Request, res: Response) => {
  try {
    const dnsProvider = createDnsProvider();
    const records = await dnsProvider.getRecords(req.params.name);
    res.status(200).json(records);
  } catch (err) {
    if (err instanceof DnsOperationError) {
      const msg = (err.originalCause as Error)?.message ?? '';
      if (msg.includes('No such zone')) {
        res.status(200).json([]);
        return;
      }
      console.warn('[dns] getRecords failed:', err.originalCause);
      res.status(500).json({ error: 'DNS operation failed' });
    } else {
      console.error(`[dns] GET /zones/${req.params.name}/records failed:`, (err as Error).message);
      res.status(502).json({ error: 'Failed to retrieve DNS records' });
    }
  }
});

// ── POST /api/dns/zones/:name/records — add a record ─────────────────────────
// Body: { type, name, value, ttl, priority? }
router.post('/zones/:name/records', async (req: Request, res: Response) => {
  const body = req.body as Partial<DnsRecord>;
  if (!body.type || !body.name || !body.value || !body.ttl) {
    res.status(400).json({ error: 'Missing required fields: type, name, value, ttl' });
    return;
  }
  try {
    const dnsProvider = createDnsProvider();
    const record = await dnsProvider.addRecord(req.params.name, {
      type: body.type,
      name: body.name,
      value: body.value,
      ttl: body.ttl,
      ...(body.priority !== undefined ? { priority: body.priority } : {}),
    });
    res.status(201).json(record);
  } catch (err) {
    if (err instanceof DnsOperationError) {
      console.warn('[dns] addRecord failed:', err.originalCause);
      res.status(500).json({ error: 'DNS operation failed' });
    } else {
      console.error(`[dns] POST /zones/${req.params.name}/records failed:`, (err as Error).message);
      res.status(502).json({ error: 'Failed to add DNS record' });
    }
  }
});

// ── PUT /api/dns/zones/:name/records/:id — update a record ───────────────────
router.put('/zones/:name/records/:id', async (req: Request, res: Response) => {
  const updates = req.body as Partial<Omit<DnsRecord, 'id'>>;
  try {
    const dnsProvider = createDnsProvider();
    const record = await dnsProvider.updateRecord(req.params.name, req.params.id, updates);
    res.status(200).json(record);
  } catch (err) {
    if (err instanceof DnsOperationError) {
      console.warn('[dns] updateRecord failed:', err.originalCause);
      res.status(500).json({ error: 'DNS operation failed' });
    } else {
      console.error(`[dns] PUT /zones/${req.params.name}/records/${req.params.id} failed:`, (err as Error).message);
      res.status(502).json({ error: 'Failed to update DNS record' });
    }
  }
});

// ── DELETE /api/dns/zones/:name/records/:id — delete a record ────────────────
router.delete('/zones/:name/records/:id', async (req: Request, res: Response) => {
  try {
    const dnsProvider = createDnsProvider();
    await dnsProvider.deleteRecord(req.params.name, req.params.id);
    res.status(204).send();
  } catch (err) {
    if (err instanceof DnsOperationError) {
      console.warn('[dns] deleteRecord failed:', err.originalCause);
      res.status(500).json({ error: 'DNS operation failed' });
    } else {
      console.error(`[dns] DELETE /zones/${req.params.name}/records/${req.params.id} failed:`, (err as Error).message);
      res.status(502).json({ error: 'Failed to delete DNS record' });
    }
  }
});

export default router;
