import type { DnsProvider } from './DnsProvider';
import { TechnitiumProvider } from './TechnitiumProvider';
import { createTechnitiumClient } from '../technitium';

export type { DnsProvider } from './DnsProvider';
export { DnsOperationError } from './errors';

let _instance: DnsProvider | null = null;

/**
 * Returns the singleton DnsProvider.
 *
 * Selection:
 *   TECHNITIUM_URL + TECHNITIUM_TOKEN set  → TechnitiumProvider
 *   Otherwise                              → throws at startup (fail fast)
 */
export function createDnsProvider(): DnsProvider {
  if (_instance) return _instance;

  const client = createTechnitiumClient();
  if (client) {
    console.log('[dns] Technitium provider active');
    _instance = new TechnitiumProvider(client);
    return _instance;
  }

  throw new Error('DNS provider not configured: set TECHNITIUM_URL and TECHNITIUM_TOKEN');
}

/** Reset singleton — for testing only. */
export function resetDnsProvider(): void {
  _instance = null;
}
