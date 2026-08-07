import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/index.ts'],
      // The shared kernel is load-bearing for every monetary value in the system.
      thresholds: { lines: 90, functions: 90, branches: 85, statements: 90 },
    },
  },
});
