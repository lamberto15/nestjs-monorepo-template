import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The API is same-origin in development too (a proxy), as behind Caddy in
// production: the __Host-sid session cookie needs it.
const api = 'http://localhost:3000';

export default defineConfig({
  plugins: [
    // Before react(): it writes src/routeTree.gen.ts and splits routes.
    tanstackRouter({ target: 'react', autoCodeSplitting: true }),
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    // Vite's `localhost` default binds one loopback address (::1 in the
    // devcontainer), which a port forward to 127.0.0.1 misses. The
    // devcontainer sets WEB_DEV_HOST to `::`, every address, IPv4 and IPv6
    // (.devcontainer/compose.yaml), where nothing is published on the host;
    // elsewhere it is unset and Vite's default stays.
    host: process.env.WEB_DEV_HOST,
    proxy: {
      '/v1': api,
      '/health': api,
      '/socket.io': { target: api, ws: true },
    },
  },
});
