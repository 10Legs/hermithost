import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Only run test files under src/ — exclude compiled dist/ output
    include: ['src/**/*.test.ts'],
  },
});
