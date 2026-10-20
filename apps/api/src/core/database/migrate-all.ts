import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate as migratePg } from 'drizzle-orm/node-postgres/migrator';
import * as schema from '../../schema.js';
import { STORED_RENAMES } from '../../stored-renames.js';
import type { Database } from './drizzle.js';
import {
  type DatabaseUrls,
  ensureAppRole,
  ensureMonitorRole,
  ensureReportingRole,
  type MonitorRole,
  type ReportingRole,
} from './roles.js';
import { applyStoredRenames } from './stored-renames.js';

/**
 * Brings the database up to this version, as its owner (`ownerUrl`): the
 * app's migrations (drizzle/), then the outbox's, the workflows' and the
 * webhooks' schemas (their CLIs), each under an advisory lock, so a second
 * run waits and then finds nothing to do. Then the app's role (`appUrl`,
 * what api and worker connect as) is created or checked and granted what
 * the new schema needs (roles.ts), and, when `monitor` names one, the
 * exporter's role (pg_monitor only), and, when `reporting` names one, the
 * platform analytics' role (the `analytics` aggregates only). Used by `node dist/migrate` (each
 * deploy), by the app when MIGRATE_ON_START is on, and by the tests (their
 * template database).
 */
export async function migrateAll(
  urls: DatabaseUrls & { monitor?: MonitorRole; reporting?: ReportingRole },
  log: (line: string) => void = () => {},
) {
  const url = urls.ownerUrl;
  const db = drizzle({ connection: url, schema });
  try {
    await migratePostgres(db);
  } finally {
    await db.$client.end();
  }
  log('App migrations applied.');
  // Names the code renamed, in the rows that store them (stored-renames.ts).
  await applyStoredRenames(url, STORED_RENAMES, log);
  const require = createRequire(import.meta.url);
  for (const name of ['outbox', 'workflows', 'webhooks']) {
    const pkg = `@nestjs/${name}`;
    const manifest = require(`${pkg}/package.json`) as {
      bin: Record<string, string>;
    };
    const bin = join(
      dirname(require.resolve(`${pkg}/package.json`)),
      manifest.bin[`nest-${name}`],
    );
    // The URL in the environment (the CLIs' default), never in the command
    // line: it holds the password, and argv shows in `ps` and in the error
    // a failed command throws.
    let output: string;
    try {
      output = execFileSync(process.execPath, [bin, 'migrate'], {
        env: { ...process.env, DATABASE_URL: url },
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
      });
    } catch (error) {
      const { stderr, stdout } = error as { stderr?: string; stdout?: string };
      throw new Error(
        `${pkg} migrate failed:\n${[stdout, stderr].filter(Boolean).join('\n').trim()}`,
        { cause: error },
      );
    }
    for (const line of output.split('\n').filter((line) => line.trim())) {
      log(`${pkg}: ${line}`);
    }
  }
  log('Store migrations applied.');
  await ensureAppRole(urls, log);
  if (urls.monitor) {
    await ensureMonitorRole(urls, urls.monitor, log);
  }
  if (urls.reporting) {
    await ensureReportingRole(urls, urls.reporting, log);
  }
}

/**
 * Applies drizzle/ on PostgreSQL under an advisory lock, so several instances
 * starting together (or a deploy's migration job and an instance) don't race:
 * the second waits, then finds nothing left to apply.
 */
export async function migratePostgres(db: Database) {
  await db.transaction(async (tx) => {
    // A migration may rewrite a large table: no statement timeout for it.
    await tx.execute(sql`set local statement_timeout = 0`);
    await tx.execute(sql`select pg_advisory_xact_lock(${MIGRATION_LOCK})`);
    await migratePg(tx as never, { migrationsFolder: MIGRATIONS_FOLDER });
  });
}

/** The advisory lock key of the app's migrations (any constant other apps don't use). */
const MIGRATION_LOCK = 7_300_421_019;

/**
 * The migrations drizzle-kit generated from schema.ts (`pnpm db:generate`):
 * `drizzle/` next to `src/` and `dist/` (this file is `src/core/database/`), so the same path works from both.
 * Applied in order, each once, recorded in `drizzle.__drizzle_migrations`.
 */
const MIGRATIONS_FOLDER = fileURLToPath(
  new URL('../../../drizzle', import.meta.url),
);
