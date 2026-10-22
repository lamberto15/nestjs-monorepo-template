import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { apiPathPattern } from './pwa-paths.ts';

const caddyfile = readFileSync(
  resolve(import.meta.dirname, '../../caddy/Caddyfile'),
  'utf8',
);

/** The `@api path ...` matcher: the paths Caddy sends to the API. */
const caddyApiPaths = (/^\s*@api path (.+)$/m.exec(caddyfile)?.[1] ?? '')
  .trim()
  .split(/\s+/);

describe('the service worker navigation denylist', () => {
  it('reads the API paths from the Caddyfile', () => {
    expect(caddyApiPaths).toContain('/v1/*');
    // The local disk's signed links are /files?key=…: the path is /files itself.
    expect(caddyApiPaths).toContain('/files');
    expect(caddyApiPaths).toContain('/files/*');
  });

  it.each(caddyApiPaths)('leaves %s to the server', (path) => {
    // `/v1/*` is any path below /v1; the others are exact.
    const url = path.endsWith('/*') ? `${path.slice(0, -1)}example` : path;
    expect(apiPathPattern.test(url)).toBe(true);
  });

  it.each(['/', '/sign-in', '/api-keys', '/files-list', '/healthy', '/v10'])(
    'serves the app shell for %s',
    (path) => {
      expect(apiPathPattern.test(path)).toBe(false);
    },
  );
});
