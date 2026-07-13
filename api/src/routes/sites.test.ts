import { describe, expect, it } from 'vitest';
import { stableComposeRouteAlias } from './sites';

describe('stableComposeRouteAlias', () => {
  it('uses a stable site-scoped alias instead of an ephemeral Coolify container name', () => {
    expect(stableComposeRouteAlias('c1ngfacciakfgbxmt96uaeoz')).toBe('site-c1ngfacciakfgbxmt96uaeoz');
  });
});
