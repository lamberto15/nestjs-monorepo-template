// A VAPID key pair for Web Push, from the web-push package's own generator
// (the one `npx web-push generate-vapid-keys` runs). The package is the API's
// dependency (apps/api/package.json), not the root's, so it is resolved from
// the API's folder: after `pnpm install`. Before that it is not there, and
// the caller says how to make the keys by hand.
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);

/** { publicKey, privateKey }, or null when web-push is not installed. */
export function generateVapidKeys() {
  const require = createRequire(path.join(REPO, 'apps/api/package.json'));
  try {
    return require('web-push').generateVAPIDKeys();
  } catch (error) {
    if (error?.code === 'MODULE_NOT_FOUND') return null;
    throw error;
  }
}
