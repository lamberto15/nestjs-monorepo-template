import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { dumpTarget } from './openapi-dump-target.js';

/**
 * Writes the OpenAPI document to a file without serving it (`pnpm
 * openapi:dump`, which builds first: `node dist/openapi-dump [file]`), for
 * the typed client in packages/api-client: its openapi.json by default, two
 * levels above this app in the repository (`apps/api` → the root). Another
 * file is a .json in the repository or the temp directory (dumpTarget).
 *
 * The app is created in NestJS's preview mode: modules and routes are
 * scanned, nothing is instantiated, so no database, Redis or port is needed.
 * The environment is a fixed one, not the developer's (.env.development is
 * not read): the document is a contract committed to the repository, so it
 * must come out the same on every machine and in CI.
 */
Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://openapi:openapi@127.0.0.1:5432/openapi',
  REDIS_URL: 'redis://127.0.0.1:6379',
  MIGRATE_ON_START: 'off',
  APP_URL: 'http://localhost:3000',
  LOCALES: 'en,de,ar,zh,ms',
  ADMIN_EMAIL: 'admin@example.com',
  MAIL_TRANSPORT: 'memory',
  STORAGE_DRIVER: 'memory',
  OPENAPI: 'on',
});

let target: string;
try {
  target = dumpTarget(process.argv[2]);
} catch (error) {
  console.error((error as Error).message);
  process.exit(2);
}

// After the environment: AppModule's ConfigModule validates it on import.
const { VersioningType } = await import('@nestjs/common');
const { NestFactory } = await import('@nestjs/core');
const { AppModule } = await import('./app.module.js');
const { buildOpenApiDocument } = await import('./openapi.js');

const app = await NestFactory.create(AppModule, {
  preview: true,
  logger: ['error'],
  abortOnError: false,
});
// What setupHttp() applies and the document shows (it reads the config,
// which preview mode doesn't instantiate). The api-client e2e compares this
// document with the served /api-json, so the two cannot drift apart.
app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
const document = buildOpenApiDocument(app);
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, `${JSON.stringify(document, null, 2)}\n`);
console.log(`OpenAPI document: ${target}`);
await app.close();
