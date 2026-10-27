import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Plugin } from 'vite';

const caddyfilePath = resolve(import.meta.dirname, '../../caddy/Caddyfile');

/**
 * The web app's headers in production, by name: the `header` block of
 * caddy/Caddyfile's web app (the Content-Security-Policy, HSTS, COOP and the
 * rest), without the origins of files Caddy adds at its start
 * (`{env.WEB_FILES_ORIGINS}`: none with the local disk).
 */
export function caddyWebHeaders(caddyfile: string): Record<string, string> {
  const block = /^(\s*)header \{\n([\s\S]*?)^\1\}/m.exec(caddyfile)?.[2];
  const headers = Object.fromEntries(
    (block ?? '')
      .split('\n')
      .map((line) => /^\s*([\w-]+) "(.*)"$/.exec(line))
      .filter((match) => match !== null)
      .map(([, name, value]) => [
        name,
        value
          .replaceAll('{env.WEB_FILES_ORIGINS}', '')
          .replace(/\s+/g, ' ')
          .replaceAll(' ;', ';'),
      ]),
  );
  if (!headers['Content-Security-Policy']) {
    throw new Error(`no web app \`header\` block in ${caddyfilePath}`);
  }
  return headers;
}

/**
 * `vite preview` (the built app the browser tests open) answers with those
 * headers (`preview.headers`), so the tests run under production's policy and
 * a violation fails them (apps/web-e2e/test/fixtures.ts). The preview only:
 * the dev server's React refresh needs an inline script the policy refuses.
 * The Caddyfile is read when the preview starts, never by a build: the Caddy
 * image's (caddy/Dockerfile) has no Caddyfile in its context.
 */
export function productionHeaders(): Plugin {
  return {
    name: 'production-headers',
    config(_config, { isPreview }) {
      if (!isPreview) return;
      return {
        preview: {
          headers: caddyWebHeaders(readFileSync(caddyfilePath, 'utf8')),
        },
      };
    },
  };
}
