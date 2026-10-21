/**
 * The paths the service worker must never answer with the app shell: the ones
 * Caddy sends to the API (the `@api` matcher in caddy/Caddyfile). A same-origin
 * navigation to one of them (an export or attachment link, a PDF preview, the
 * OpenAPI document) must reach the server, not `index.html`.
 *
 * Whole path segments, no bare prefixes: `api` is Swagger UI, and `api-json`
 * and `api-yaml` its documents, but `/api-keys` is the web app's own page.
 * pwa-paths.test.ts keeps this list in step with the Caddyfile.
 */
export const apiPathPattern =
  /^\/(v1|health|metrics|api|api-json|api-yaml|files|socket\.io|\.well-known)(\/|$)/;
