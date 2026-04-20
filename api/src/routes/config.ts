import { Router, Request, Response } from 'express';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { createCoolifyClient } from '../services/coolify';
import { createTechnitiumClient } from '../services/technitium';

const router = Router();

const NS_HOSTNAME_FILE = '/coolify-api-token/ns_hostname';
const DNS_PROVIDER_FILE = '/coolify-api-token/dns_provider';
const CLOUDFLARE_TOKEN_FILE = '/coolify-api-token/cloudflare_token';
const NETWORK_MODE_FILE = '/coolify-api-token/network_mode';

// network_mode read precedence:
// 1. File /coolify-api-token/network_mode
// 2. process.env.NETWORK_MODE
// 3. 'external'
export function readNetworkMode(): 'external' | 'internal' {
  try {
    const val = readFileSync(NETWORK_MODE_FILE, 'utf8').trim();
    if (val === 'internal') return 'internal';
  } catch { /* file not present */ }
  return process.env.NETWORK_MODE === 'internal' ? 'internal' : 'external';
}

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

function readSetting(key: string): string | null {
  try {
    const val = readFileSync(`/coolify-api-token/${key}`, 'utf8').trim();
    return val || null;
  } catch {
    return null;
  }
}

type IntegrationStatus = 'connected' | 'error' | 'not_configured';
type CloudflareStatus = 'connected' | 'disconnected' | 'unconfigured';

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

async function getCloudflareStatus(token: string | null): Promise<CloudflareStatus> {
  if (!token || !token.trim()) return 'unconfigured';
  try {
    const res = await fetch('https://api.cloudflare.com/client/v4/user/tokens/verify', {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    const data = await res.json() as { success: boolean };
    return data.success ? 'connected' : 'disconnected';
  } catch {
    return 'disconnected';
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
    const cfToken = readSetting('cloudflare_token') ?? process.env.CLOUDFLARE_TOKEN ?? null;
    const [coolify_status, technitium_status, cloudflare_status] = await Promise.all([
      getCoolifyStatus(),
      getTechnitiumStatus(),
      getCloudflareStatus(cfToken),
    ]);

    const dns_provider = readSetting('dns_provider') ?? process.env.DNS_PROVIDER ?? 'technitium';

    res.status(200).json({
      ns_hostname: readNsHostname(),
      acme_email: process.env.ACME_EMAIL ?? null,
      coolify_url: process.env.COOLIFY_API_URL ?? null,
      coolify_status,
      technitium_url: process.env.TECHNITIUM_URL ?? null,
      technitium_status,
      dns_provider,
      cloudflare_status,
      cloudflare_token_set: !!cfToken,
      network_mode: readNetworkMode(),
    });
  } catch (err) {
    console.error('[config] GET failed:', (err as Error).message);
    res.status(500).json({ error: 'Failed to retrieve config' });
  }
});

// PUT /api/config
router.put('/', async (req: Request, res: Response) => {
  const body = req.body as {
    ns_hostname?: unknown;
    dns_provider?: unknown;
    cloudflare_token?: unknown;
    network_mode?: unknown;
  };

  // Validate at least one known key is present
  const hasNsHostname = typeof body.ns_hostname === 'string' && body.ns_hostname.trim();
  const hasDnsProvider = typeof body.dns_provider === 'string' && body.dns_provider.trim();
  const hasCfToken = typeof body.cloudflare_token === 'string';
  const hasNetworkMode = typeof body.network_mode === 'string' && body.network_mode.trim();

  if (!hasNsHostname && !hasDnsProvider && !hasCfToken && !hasNetworkMode) {
    res.status(400).json({ error: 'At least one field required: ns_hostname, dns_provider, cloudflare_token, network_mode' });
    return;
  }

  // Validate dns_provider enum if provided
  if (hasDnsProvider && !['technitium', 'cloudflare'].includes((body.dns_provider as string).trim())) {
    res.status(400).json({ error: 'dns_provider must be "technitium" or "cloudflare"' });
    return;
  }

  // Validate network_mode enum if provided
  if (hasNetworkMode && !['external', 'internal', 'mixed'].includes((body.network_mode as string).trim())) {
    res.status(400).json({ error: 'network_mode must be "external" or "internal"' });
    return;
  }

  try {
    // Ensure directory exists (best-effort — directory is normally created by init container)
    try { mkdirSync('/coolify-api-token', { recursive: true }); } catch { /* ok */ }

    const result: Record<string, string> = {};

    if (hasNsHostname) {
      const value = (body.ns_hostname as string).trim();
      writeFileSync(NS_HOSTNAME_FILE, value, 'utf8');
      // Sync new hostname to Technitium immediately — non-fatal
      const client = createTechnitiumClient();
      if (client) {
        client.setDnsServerDomain(value).catch((e: Error) =>
          console.warn('[config] setDnsServerDomain after PUT failed:', e.message)
        );
      }
      result.ns_hostname = value;
    }

    if (hasDnsProvider) {
      const value = (body.dns_provider as string).trim();
      writeFileSync(DNS_PROVIDER_FILE, value, 'utf8');
      result.dns_provider = value;
    }

    if (hasCfToken) {
      const value = (body.cloudflare_token as string).trim();
      writeFileSync(CLOUDFLARE_TOKEN_FILE, value, 'utf8');
      result.cloudflare_token_set = value ? 'true' : 'false';
      const cloudflare_status = await getCloudflareStatus(value || null);
      result.cloudflare_status = cloudflare_status;
    }

    if (hasNetworkMode) {
      const value = (body.network_mode as string).trim() as 'external' | 'internal' | 'mixed';
      writeFileSync(NETWORK_MODE_FILE, value, 'utf8');
      result.network_mode = value;
    }

    res.status(200).json(result);
  } catch (err) {
    console.error('[config] PUT failed:', (err as Error).message);
    res.status(500).json({ error: 'Failed to write config' });
  }
});

// GET /api/config/trust-certificate
router.get('/trust-certificate', (_req: Request, res: Response) => {
  const certPath = '/home/step/certs/root_ca.crt';
  try {
    const cert = readFileSync(certPath);
    res.setHeader('Content-Type', 'application/x-x509-ca-cert');
    res.setHeader('Content-Disposition', 'attachment; filename="hermithost-trust.crt"');
    res.send(cert);
  } catch {
    res.status(404).json({ error: 'Trust certificate not available — internal mode not configured' });
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
