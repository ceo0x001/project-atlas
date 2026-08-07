import { resolve } from 'node:path';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/**
 * Integration tests: these talk to a real Postgres with the real migration and real
 * row-level security applied. Run `pnpm infra:up` first.
 *
 * Kept separate from the unit suite so the default `pnpm test` stays fast and
 * infrastructure-free, and so CI can adopt them once it has a Postgres service.
 */
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  resolve: {
    alias: {
      '@config': resolve(__dirname, 'src/config'),
      '@modules': resolve(__dirname, 'src/modules'),
      '@shared': resolve(__dirname, 'src/shared'),
    },
  },
  test: {
    include: ['**/*.integration.test.ts'],
    exclude: ['**/node_modules/**'],
    environment: 'node',
    // Shared database: parallel files would fight over the same rows.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    env: {
      // Phone sign-in is disabled by default (ADR-009), which is right for a single-user
      // deployment but would make the sign-in tests assert a 503 instead of exercising the flow.
      // The log sender keeps that whole surface under test — including its abuse cases — so
      // enabling a second user later does not mean shipping untested authentication.
      OTP_SENDER: 'log',
    },
  },
});
