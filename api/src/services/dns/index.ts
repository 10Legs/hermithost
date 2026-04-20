import { readFileSync } from 'fs';
import type { DnsProvider } from './DnsProvider';
import { TechnitiumProvider } from './TechnitiumProvider';
import { CloudflareProvider } from './CloudflareProvider';
import { createTechnitiumClient } from '../technitium';

export type { DnsProvider } from './DnsProvider';
export type { DnsZone } from './DnsProvider';
export { DnsOperationError } from './errors';

/**
 * Read a persisted setting from /coolify-api-token/<key>.
 * Returns null if the file is absent or empty.
 */
function readSetting(key: string): string | null {
  try {
    const val = readFileSync(`/coolify-api-token/${key}`, 'utf8').trim();
    return val || null;
  } catch {
    return null;
  }
}

/**
 * Returns a DnsProvider based on the active dns_provider setting.
 * Precedence: persisted file → env var → 'technitium' default.
 *
 * For Technitium: token is read fresh each call (tokens are session-scoped
 * and written by coolify-setup.sh on boot).
 */
export function createDnsProvider(): DnsProvider {
  const provider = readSetting('dns_provider') ?? process.env.DNS_PROVIDER ?? 'technitium';

  if (provider === 'cloudflare') {
    const token = readSetting('cloudflare_token') ?? process.env.CLOUDFLARE_TOKEN ?? '';
    if (!token) {
      // Intentional: operator must configure token before switching provider.
      // No silent fallback — misconfiguration should fail loudly.
      throw new Error('Cloudflare DNS provider selected but CLOUDFLARE_TOKEN is not set');
    }
    return new CloudflareProvider(token);
  }

  const client = createTechnitiumClient();
  if (client) {
    return new TechnitiumProvider(client);
  }

  throw new Error('DNS provider not configured: set TECHNITIUM_URL and TECHNITIUM_TOKEN');
}
