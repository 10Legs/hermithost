import type { DnsProvider } from './DnsProvider';
import { TechnitiumProvider } from './TechnitiumProvider';
import { MockProvider } from './MockProvider';
import { createTechnitiumClient } from '../technitium';

export type { DnsProvider } from './DnsProvider';
export { DnsOperationError } from './errors';

let _instance: DnsProvider | null = null;

/**
 * Returns the singleton DnsProvider.
 *
 * Selection:
 *   DNS_MOCK=true                          → MockProvider (explicit override)
 *   TECHNITIUM_URL + TECHNITIUM_TOKEN set  → TechnitiumProvider
 *   Otherwise                              → MockProvider (graceful fallback)
 *
 * Caller never knows which provider is active.
 */
export function createDnsProvider(): DnsProvider {
  if (_instance) return _instance;

  if (process.env.DNS_MOCK === 'true') {
    console.log('[dns] Mock mode forced via DNS_MOCK=true');
    _instance = new MockProvider();
    return _instance;
  }

  const client = createTechnitiumClient();
  if (client) {
    console.log('[dns] Technitium provider active');
    _instance = new TechnitiumProvider(client);
  } else {
    console.log('[dns] No DNS credentials configured — using mock provider');
    _instance = new MockProvider();
  }
  return _instance;
}

/** Reset singleton — for testing only. */
export function resetDnsProvider(): void {
  _instance = null;
}
