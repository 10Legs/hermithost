import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Only run test files under src/ — exclude compiled dist/ output.
    // Integration tests use the .integration.test.ts suffix and hit the
    // live local stack (TLS handshake, docker logs, Technitium API).
    include: ['src/**/*.test.ts', 'src/**/*.integration.test.ts'],
    testTimeout: 20000,
  },
});
