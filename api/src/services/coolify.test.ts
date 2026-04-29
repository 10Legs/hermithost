import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CoolifyClient } from './coolify';

// Minimal stub for CoolifyClient — we only need to verify setApplicationEnvs dedup behaviour
// without making real HTTP calls.

function makeClient(): CoolifyClient {
  return new CoolifyClient('http://localhost:8000', 'test-token');
}

describe('CoolifyClient.setApplicationEnvs — dedup logic', () => {
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
