import { resolve } from 'node:path';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // NestJS relies on emitted decorator metadata for dependency injection, which
  // esbuild (vitest's default transform) does not produce. SWC does.
  plugins: [swc.vite({ module: { type: 'es6' } })],
  resolve: {
    alias: {
      '@config': resolve(__dirname, 'src/config'),
      '@modules': resolve(__dirname, 'src/modules'),
      '@shared': resolve(__dirname, 'src/shared'),
    },
  },
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    // Integration tests need a live Postgres, so they run separately
    // (`pnpm test:integration`) and stay out of the default unit run.
    exclude: ['**/node_modules/**', '**/*.integration.test.ts'],
    environment: 'node',
  },
});
