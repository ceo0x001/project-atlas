import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Atlas web client.
 *
 * A static single-page app: there is no server-side rendering and no backend of its own. It
 * talks to the Atlas API with a device bearer token, which means it deploys as plain files and
 * can be hosted anywhere — including a phone's home screen via the manifest.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    // Reachable from a phone on the same network, which is the fastest way to judge a mobile
    // layout: a desktop browser at 390px wide is not the same as the device.
    host: true,
    port: 5173,
  },
  build: { outDir: 'dist', sourcemap: true },
});
