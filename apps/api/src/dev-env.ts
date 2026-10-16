import { existsSync } from 'node:fs';
import { appPath } from './app-dir.js';

/**
 * The development settings (env.development.example): `apps/api/.env.development`,
 * next to the app's package.json, whatever directory it was started from.
 * Production gets its environment from Compose, the tests from
 * test/setup-env.ts: the file is ignored there.
 */
export const DEV_ENV_FILE = appPath('.env.development');
export const ignoreDevEnvFile = ['test', 'production'].includes(
  process.env.NODE_ENV ?? '',
);

// Into process.env before anything else is evaluated (main.ts imports this
// module first). ConfigModule reads the file too, but only while the app
// boots: too late for NestFactory's options, where NestJS Observe's
// `instrument` is decided from the environment before any module loads, and
// for packages that read process.env themselves. Node's own loader, so
// nothing new to depend on; what the shell set wins, as with ConfigModule,
// which validates the same values afterwards.
if (!ignoreDevEnvFile && existsSync(DEV_ENV_FILE)) {
  process.loadEnvFile(DEV_ENV_FILE);
}
