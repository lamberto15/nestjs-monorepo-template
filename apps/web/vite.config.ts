import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { devProxy } from './dev-proxy.ts';
import { apiPathPattern } from './pwa-paths.ts';

// The API is same-origin in development too (a proxy: dev-proxy.ts), as behind
// Caddy in production: the __Host-sid session cookie needs it.
// API_URL: the browser tests' API runs elsewhere (apps/web-e2e), beside a dev stack.
const api = process.env.API_URL ?? 'http://localhost:3000';
const proxy = devProxy(api);

const gitSha = process.env.GIT_SHA ?? '';
const webRoot = fileURLToPath(new URL('.', import.meta.url));
const bundleReportDir = fileURLToPath(
  new URL('./.bundle-analysis/', import.meta.url),
);
const bundleReportFile = fileURLToPath(
  new URL('./.bundle-analysis/bundle.json', import.meta.url),
);

// The folders of src/locales except `en`, which is bundled (src/i18n.ts).
const lazyLanguages = readdirSync(new URL('./src/locales', import.meta.url))
  .filter((language) => language !== 'en')
  .toSorted();

export default defineConfig({
  define: { __APP_GIT_SHA__: JSON.stringify(gitSha) },
  plugins: [
    {
      name: 'build-version-manifest',
      apply: 'build',
      generateBundle() {
        this.emitFile({
          type: 'asset',
          fileName: 'version.json',
          source: JSON.stringify({ sha: gitSha }),
        });
      },
    },
    {
      // Measurement only: this report stays outside dist/, so it is never
      // shipped by Caddy or precached by the PWA. CI keeps it as an artifact.
      name: 'bundle-analysis',
      apply: 'build',
      generateBundle(_options, bundle) {
        const chunks = Object.values(bundle)
          .filter((output) => output.type === 'chunk')
          .map((chunk) => ({
            file: chunk.fileName,
            bytes: Buffer.byteLength(chunk.code),
            gzipBytes: gzipSync(chunk.code).byteLength,
            brotliBytes: brotliCompressSync(chunk.code).byteLength,
            modules: Object.entries(chunk.modules)
              .map(([id, details]) => ({
                id: relative(webRoot, id),
                renderedBytes: details.renderedLength,
              }))
              .filter((module) => module.renderedBytes > 0)
              .toSorted(
                (a, b) =>
                  b.renderedBytes - a.renderedBytes || a.id.localeCompare(b.id),
              ),
          }))
          .toSorted(
            (a, b) => b.gzipBytes - a.gzipBytes || a.file.localeCompare(b.file),
          );
        mkdirSync(bundleReportDir, { recursive: true });
        writeFileSync(
          bundleReportFile,
          JSON.stringify({ version: 1, chunks }, null, 2) + '\n',
        );
      },
    },
    // Before react(): it writes src/routeTree.gen.ts and splits routes.
    tanstackRouter({ target: 'react', autoCodeSplitting: true }),
    react(),
    tailwindcss(),
    // vite-plugin-pwa's documented setup (generateSW, Workbox). The worker
    // precaches the built shell only (scripts, styles, icons); its one runtime
    // cache holds the build's own language files, so no API response (user
    // data) is ever stored by it.
    // Navigations fall back to the shell except for the API's own paths.
    VitePWA({
      registerType: 'prompt',
      includeAssets: [
        'favicon.ico',
        'favicon.svg',
        'apple-touch-icon-180x180.png',
      ],
      manifest: {
        name: 'App',
        short_name: 'App',
        description: 'The web app',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        theme_color: '#863bff',
        background_color: '#ffffff',
        icons: [
          { src: 'pwa-64x64.png', sizes: '64x64', type: 'image/png' },
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          {
            src: 'maskable-icon-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // Web Push: the push and notification-click handlers (public/push-sw.js).
        importScripts: ['push-sw.js'],
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2}'],
        globIgnores: [
          // Only `en` (the fallback) is in the entry. The other languages are
          // not precached: nearly everybody uses one, and precaching all four
          // would make every install download the three it never uses
          // (#705). They are cached the first time they are loaded instead
          // (runtimeCaching below), so offline works for a language already
          // used; before that, offline shows English.
          '**/assets/locale-*.js',
        ],
        runtimeCaching: [
          {
            // Hashed, immutable files of the build itself (no user data):
            // CacheFirst is Workbox's strategy for such files.
            urlPattern: ({ url }) =>
              /^\/assets\/locale-[^/]+\.js$/.test(url.pathname),
            handler: 'CacheFirst',
            options: {
              cacheName: 'locales',
              expiration: { maxEntries: 200 },
            },
          },
        ],
        cleanupOutdatedCaches: true,
        navigateFallback: 'index.html',
        // What Caddy sends to the API (routes, Swagger UI and its documents,
        // stored files, the socket) is never the shell: pwa-paths.ts.
        navigateFallbackDenylist: [apiPathPattern],
      },
    }),
  ],
  build: {
    rolldownOptions: {
      output: {
        // Every locale chunk is named `locale-*` (the language's chunk, and
        // the small module that loads one namespace file): the service
        // worker (VitePWA above) leaves exactly these out of the precache.
        chunkFileNames: (chunk) =>
          chunk.facadeModuleId?.includes('/src/locales/')
            ? 'assets/locale-[name]-[hash].js'
            : 'assets/[name]-[hash].js',
        // One chunk per language (src/i18n.ts loads a language on demand):
        // without it each of the 36 namespace files is its own request.
        // `en` is bundled in the entry and has no group.
        codeSplitting: {
          groups: lazyLanguages.map((language) => ({
            name: `locale-${language}`,
            test: new RegExp(`/src/locales/${language}/`),
          })),
        },
      },
    },
  },
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
    proxy,
  },
  // `vite preview` (the built app, what the browser tests open) proxies the
  // same way: one origin, as behind Caddy (docs/development.md, "Browser tests").
  preview: { proxy },
});
