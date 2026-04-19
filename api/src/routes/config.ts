import { Router, Request, Response } from 'express';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { createCoolifyClient } from '../services/coolify';
import { createTechnitiumClient } from '../services/technitium';

const router = Router();

const NS_HOSTNAME_FILE = '/coolify-api-token/ns_hostname';

// NS_HOSTNAME read precedence:
// 1. File /coolify-api-token/ns_hostname
// 2. process.env.NS_HOSTNAME
// 3. null
export function readNsHostname(): string | null {
  try {
    const val = readFileSync(NS_HOSTNAME_FILE, 'utf8').trim();
    if (val) return val;
  } catch { /* file not present */ }
  return process.env.NS_HOSTNAME ?? null;
}

const NS_SERVER_IP_FILE = '/coolify-api-token/ns_server_ip';

// NS_SERVER_IP read precedence:
// 1. File /coolify-api-token/ns_server_ip (written by coolify-server-setup)
// 2. process.env.NS_SERVER_IP
// 3. null
export function readNsServerIp(): string | null {
  try {
    const val = readFileSync(NS_SERVER_IP_FILE, 'utf8').trim();
    if (val) return val;
  } catch { /* file not present */ }
  return process.env.NS_SERVER_IP ?? null;
}

type IntegrationStatus = 'connected' | 'error' | 'not_configured';

async function getCoolifyStatus(): Promise<IntegrationStatus> {
  const client = createCoolifyClient();
  if (!client) return 'not_configured';
  try {
    await client.getServers();
    return 'connected';
  } catch {
    return 'error';
  }
}

async function getTechnitiumStatus(): Promise<IntegrationStatus> {
  const client = createTechnitiumClient();
  if (!client) return 'not_configured';
  try {
    await client.listZones();
    return 'connected';
  } catch {
    return 'error';
  }
}

// GET /api/config
router.get('/', async (_req: Request, res: Response) => {
  try {
    const [coolify_status, technitium_status] = await Promise.all([
      getCoolifyStatus(),
      getTechnitiumStatus(),
    ]);

    res.status(200).json({
      ns_hostname: readNsHostname(),
      acme_email: process.env.ACME_EMAIL ?? null,
      coolify_url: process.env.COOLIFY_API_URL ?? null,
      coolify_status,
      technitium_url: process.env.TECHNITIUM_URL ?? null,
      technitium_status,
    });
  } catch (err) {
    console.error('[config] GET failed:', (err as Error).message);
    res.status(500).json({ error: 'Failed to retrieve config' });
  }
});

// PUT /api/config
router.put('/', async (req: Request, res: Response) => {
  const body = req.body as { ns_hostname?: unknown };

  if (typeof body.ns_hostname !== 'string' || !body.ns_hostname.trim()) {
    res.status(400).json({ error: 'ns_hostname must be a non-empty string' });
    return;
  }

  const value = body.ns_hostname.trim();

  try {
    // Ensure directory exists (best-effort — directory is normally created by init container)
    try { mkdirSync('/coolify-api-token', { recursive: true }); } catch { /* ok */ }
    writeFileSync(NS_HOSTNAME_FILE, value, 'utf8');
    // Sync new hostname to Technitium immediately — non-fatal
    const client = createTechnitiumClient();
    if (client) {
      client.setDnsServerDomain(value).catch((e: Error) =>
        console.warn('[config] setDnsServerDomain after PUT failed:', e.message)
      );
    }
    res.status(200).json({ ns_hostname: value });
  } catch (err) {
    console.error('[config] PUT write ns_hostname failed:', (err as Error).message);
    res.status(500).json({ error: 'Failed to write ns_hostname' });
  }
});

// GET /api/config/deploy-key
router.get('/deploy-key', (_req: Request, res: Response) => {
  const candidates = [
    '/coolify-api-token/github_deploy.pub',
    '/coolify-keys/github_deploy.pub',
  ];
  for (const path of candidates) {
    try {
      const key = readFileSync(path, 'utf8').trim();
      if (key) { res.json({ public_key: key }); return; }
    } catch { /* try next */ }
  }
  res.status(404).json({ error: 'Deploy key not found' });
});

export default router;
