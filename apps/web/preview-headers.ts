import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const caddyfile = resolve(import.meta.dirname, '../../caddy/Caddyfile');

/**
 * The response headers Caddy puts on the web app's files (the block that
 * follows "Security headers of the web app only" in caddy/Caddyfile), for
 * `vite preview` to send too (`preview.headers`). The browser tests then run
 * the built app under the production Content-Security-Policy; the policy
 * stays written in one place. A `{env.NAME}` placeholder (Caddy reads it from
 * its environment: the file storage origins) is left out, as when it is unset.
 * It throws when the block or the policy is not found, so a reworded
 * Caddyfile fails the preview rather than silently dropping the headers.
 */
export function caddyHeaders(
  text = readFileSync(caddyfile, 'utf8'),
): Record<string, string> {
  const lines = text.split('\n');
  const anchor = lines.findIndex((line) =>
    line.includes('Security headers of the web app only'),
  );
  const open = lines.findIndex(
    (line, index) => index > anchor && /^\s*header \{\s*$/.test(line),
  );
  const headers: Record<string, string> = {};
  if (anchor !== -1 && open !== -1) {
    for (const line of lines.slice(open + 1)) {
      if (/^\s*\}\s*$/.test(line)) break;
      const header = /^\s*([A-Za-z][A-Za-z-]*) "(.*)"\s*$/.exec(line);
      if (header) {
        headers[header[1]] = header[2].replace(/ ?\{env\.\w+\}/g, '');
      }
    }
  }
  if (!headers['Content-Security-Policy']) {
    throw new Error(
      'caddy/Caddyfile: no Content-Security-Policy in the web app header block',
    );
  }
  return headers;
}
