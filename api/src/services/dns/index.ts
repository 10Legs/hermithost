import type { DnsProvider } from './DnsProvider';
import { TechnitiumProvider } from './TechnitiumProvider';
import { createTechnitiumClient } from '../technitium';

export type { DnsProvider } from './DnsProvider';
export { DnsOperationError } from './errors';

/**
 * Returns a DnsProvider with a fresh token on every call.
 * Technitium tokens are session-scoped and expire; reading the token file
 * each time ensures the provider always uses the current token written by
 * coolify-setup.sh on boot (or by a token refresh).
 */
export function createDnsProvider(): DnsProvider {
  const client = createTechnitiumClient();
  if (client) {
    return new TechnitiumProvider(client);
  }

  throw new Error('DNS provider not configured: set TECHNITIUM_URL and TECHNITIUM_TOKEN');
}
