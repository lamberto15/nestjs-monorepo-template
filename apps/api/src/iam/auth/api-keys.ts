import { createHash, randomBytes } from 'node:crypto';
import { logRedaction } from '../../core/logging/redaction.js';

/** The prefix of API client keys: `<prefix>_<id>_<secret>`. Rename it per project (e.g. `acme`). */
export const API_KEY_PREFIX = 'sk';

/** @nestjs/authentication's API key format: a 64-bit hex id and a 256-bit base64url secret. */
const API_KEY = new RegExp(
  `^${API_KEY_PREFIX}_([0-9a-f]{16})_[A-Za-z0-9_-]{43}$`,
);

// A whole key in a log line or an error report loses its secret part; the
// prefix and the id stay, which is what finds the client.
logRedaction.declarePatterns(
  new RegExp(`(?<=\\b${API_KEY_PREFIX}_[0-9a-f]{16}_)[A-Za-z0-9_-]{43}`, 'g'),
);

/** As ApiKeyProvider compares it: the SHA-256 of the whole key, in base64url. */
export const hashApiKey = (key: string) =>
  createHash('sha256').update(key).digest('base64url');

/** The key's public id, or `undefined` when it isn't one of our keys. */
export const apiKeyId = (key: string) => API_KEY.exec(key)?.[1];

/** A new key, as `ApiKeyProvider.generate()` makes them. Shown once; only its id and hash are stored. */
export const generateApiKey = () =>
  `${API_KEY_PREFIX}_${randomBytes(8).toString('hex')}_${randomBytes(32).toString('base64url')}`;
