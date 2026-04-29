import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CoolifyClient } from './coolify';

// Minimal stub for CoolifyClient — we only need to verify env dedup behaviour
// without making real HTTP calls.

function makeClient(): CoolifyClient {
  return new CoolifyClient('http://localhost:8000', 'test-token');
}

describe('CoolifyClient.setApplicationEnvs — dedup logic (safety net)', () => {
  let client: CoolifyClient;

  beforeEach(() => {
    client = makeClient();
  });

  it('skips keys that already exist in Coolify', async () => {
    // Arrange: Coolify already has DB_PASSWORD and DB_USER
    vi.spyOn(client, 'listEnvs').mockResolvedValue([
      { uuid: 'u1', key: 'DB_PASSWORD', value: 'secret', is_shown_once: false, is_runtime: true, is_buildtime: false, is_preview: false },
      { uuid: 'u2', key: 'DB_USER', value: 'postgres', is_shown_once: false, is_runtime: true, is_buildtime: false, is_preview: false },
    ]);
    const createEnvSpy = vi.spyOn(client, 'createEnv').mockResolvedValue(undefined);

    // Act: attempt to seed 3 vars (2 already exist, 1 new)
    await client.setApplicationEnvs('app-uuid', [
      { key: 'DB_PASSWORD', value: 'new-secret' },
      { key: 'DB_USER', value: 'newuser' },
      { key: 'NEW_VAR', value: 'hello' },
    ]);

    // Assert: only the new key is created
    expect(createEnvSpy).toHaveBeenCalledTimes(1);
    expect(createEnvSpy).toHaveBeenCalledWith('app-uuid', expect.objectContaining({ key: 'NEW_VAR', value: 'hello' }));
  });

  it('creates all vars when Coolify has none', async () => {
    vi.spyOn(client, 'listEnvs').mockResolvedValue([]);
    const createEnvSpy = vi.spyOn(client, 'createEnv').mockResolvedValue(undefined);

    await client.setApplicationEnvs('app-uuid', [
      { key: 'FOO', value: 'bar' },
      { key: 'BAZ', value: 'qux' },
    ]);

    expect(createEnvSpy).toHaveBeenCalledTimes(2);
  });

  it('proceeds without dedup when listEnvs throws (non-fatal)', async () => {
    vi.spyOn(client, 'listEnvs').mockRejectedValue(new Error('network error'));
    const createEnvSpy = vi.spyOn(client, 'createEnv').mockResolvedValue(undefined);

    await client.setApplicationEnvs('app-uuid', [
      { key: 'FOO', value: 'bar' },
    ]);

    // Should still attempt to create even if dedup fetch failed
    expect(createEnvSpy).toHaveBeenCalledTimes(1);
  });
});

describe('CoolifyClient.syncApplicationEnvs — race-safe env sync', () => {
  let client: CoolifyClient;

  beforeEach(() => {
    client = makeClient();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('patches empty values on Coolify auto-extracted rows without creating duplicates', async () => {
    // Coolify auto-extracted 3 env vars (POSTGRES_PASSWORD is empty, others have values)
    vi.spyOn(client, 'listEnvs').mockResolvedValue([
      { uuid: 'u1', key: 'POSTGRES_PASSWORD', value: '', is_shown_once: false, is_runtime: true, is_buildtime: false, is_preview: false },
      { uuid: 'u2', key: 'NODE_ENV', value: 'production', is_shown_once: false, is_runtime: true, is_buildtime: false, is_preview: false },
      { uuid: 'u3', key: 'POSTGRES_DB', value: 'mydb', is_shown_once: false, is_runtime: true, is_buildtime: false, is_preview: false },
    ]);
    const patchSpy = vi.spyOn(client, 'patchEnvByKey').mockResolvedValue(undefined);
    const createSpy = vi.spyOn(client, 'createEnv').mockResolvedValue(undefined);

    const syncPromise = client.syncApplicationEnvs(
      'app-uuid',
      [
        { key: 'POSTGRES_PASSWORD', value: 'generated-secret-abc123' },
        { key: 'NODE_ENV', value: 'production' },
        { key: 'POSTGRES_DB', value: 'mydb' },
      ],
      new Set(['POSTGRES_PASSWORD']),
      5_000,
    );

    // Advance timer past the first poll interval
    await vi.advanceTimersByTimeAsync(600);
    await syncPromise;

    // POSTGRES_PASSWORD has empty value → should be patched
    expect(patchSpy).toHaveBeenCalledTimes(1);
    expect(patchSpy).toHaveBeenCalledWith('app-uuid', { key: 'POSTGRES_PASSWORD', value: 'generated-secret-abc123' });

    // NODE_ENV and POSTGRES_DB already have values → no patch, no create
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('creates vars that Coolify did not auto-extract', async () => {
    // Coolify only extracted 2 of 3 vars (ANTHROPIC_API_KEY missing)
    vi.spyOn(client, 'listEnvs').mockResolvedValue([
      { uuid: 'u1', key: 'NODE_ENV', value: 'production', is_shown_once: false, is_runtime: true, is_buildtime: false, is_preview: false },
      { uuid: 'u2', key: 'POSTGRES_DB', value: '', is_shown_once: false, is_runtime: true, is_buildtime: false, is_preview: false },
    ]);
    const patchSpy = vi.spyOn(client, 'patchEnvByKey').mockResolvedValue(undefined);
    const createSpy = vi.spyOn(client, 'createEnv').mockResolvedValue(undefined);

    const syncPromise = client.syncApplicationEnvs(
      'app-uuid',
      [
        { key: 'NODE_ENV', value: 'production' },
        { key: 'POSTGRES_DB', value: '' },
        { key: 'ANTHROPIC_API_KEY', value: 'sk-abc' },
      ],
      new Set([]),
      5_000,
    );

    await vi.advanceTimersByTimeAsync(600);
    await syncPromise;

    // ANTHROPIC_API_KEY not in Coolify → must be created
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(createSpy).toHaveBeenCalledWith('app-uuid', expect.objectContaining({ key: 'ANTHROPIC_API_KEY', value: 'sk-abc' }));

    // POSTGRES_DB is empty and our value is also empty → no patch needed
    expect(patchSpy).not.toHaveBeenCalled();
  });

  it('falls back to setApplicationEnvs when Coolify envs never appear', async () => {
    // listEnvs always returns empty (Coolify never auto-extracts)
    const listSpy = vi.spyOn(client, 'listEnvs').mockResolvedValue([]);
    const setEnvsSpy = vi.spyOn(client, 'setApplicationEnvs').mockResolvedValue(undefined);

    const syncPromise = client.syncApplicationEnvs(
      'app-uuid',
      [{ key: 'FOO', value: 'bar' }],
      new Set([]),
      1_000, // short timeout for test speed
    );

    // Advance past the full timeout
    await vi.advanceTimersByTimeAsync(1_100);
    await syncPromise;

    // Should fall back to setApplicationEnvs
    expect(setEnvsSpy).toHaveBeenCalledWith('app-uuid', [{ key: 'FOO', value: 'bar' }]);
    expect(listSpy.mock.calls.length).toBeGreaterThan(1);
  });
});
