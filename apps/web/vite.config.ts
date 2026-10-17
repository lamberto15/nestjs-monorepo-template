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
    proxy: {
      '/v1': api,
      '/health': api,
      '/socket.io': { target: api, ws: true },
    },
  },
});
