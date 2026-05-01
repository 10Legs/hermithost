import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// readNetworkMode() derives from HERMITHOST_PORT_MODE — no file I/O involved.
// We test by manipulating process.env directly.

describe('readNetworkMode()', () => {
  const originalPortMode = process.env.HERMITHOST_PORT_MODE;

  afterEach(() => {
    // Restore original env value after each test
    if (originalPortMode === undefined) {
      delete process.env.HERMITHOST_PORT_MODE;
    } else {
      process.env.HERMITHOST_PORT_MODE = originalPortMode;
    }
    vi.restoreAllMocks();
  });

  it('lan → internal', async () => {
    process.env.HERMITHOST_PORT_MODE = 'lan';
    // Re-import to pick up env change
    const { readNetworkMode } = await import('./config');
    expect(readNetworkMode()).toBe('internal');
  });

  it('internet → external', async () => {
    process.env.HERMITHOST_PORT_MODE = 'internet';
    const { readNetworkMode } = await import('./config');
    expect(readNetworkMode()).toBe('external');
  });

  it('unset → external (safe default) and emits a warning', async () => {
    delete process.env.HERMITHOST_PORT_MODE;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { readNetworkMode } = await import('./config');
    const result = readNetworkMode();
    expect(result).toBe('external');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('HERMITHOST_PORT_MODE is not set'),
    );
  });
});
