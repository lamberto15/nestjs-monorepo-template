import { eq, is } from 'drizzle-orm';
import { drizzle as drizzleNodePg } from 'drizzle-orm/node-postgres';
import {
  getTableConfig,
  type PgDatabase,
  type PgQueryResultHKT,
  PgTable,
  type PgTransaction,
} from 'drizzle-orm/pg-core';
import type { ExtractTablesWithRelations } from 'drizzle-orm';
import * as schema from '../../schema.js';
import { migrateAll } from './migrate-all.js';
import { registerTenantTables, TenantPool } from '../tenancy/tenant-pool.js';

/** A Drizzle PostgreSQL database (node-postgres). */
export type Database = PgDatabase<PgQueryResultHKT, typeof schema>;

/** The `tx` that `db.transaction()` hands its callback. */
export type Transaction = PgTransaction<
  PgQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

/** The pool of a process (core.env.ts: DATABASE_POOL_*). */
export type PoolSettings = {
  max: number;
  timeoutMs: number;
  statementTimeoutMs: number;
  idleTxTimeoutMs: number;
  applicationName: string;
};

/**
 * PostgreSQL on `url` (DATABASE_URL, the app's role), with the pool's
 * limits. With `migrate` (MIGRATE_ON_START, development), pending migrations
 * are applied first as the owner (`ownerUrl`, DATABASE_OWNER_URL), which
 * also creates the app's role on a fresh server: the pool below can't, since
 * the app's role owns nothing and may not change the schema. Production runs
 * the same once per deploy instead (`node dist/migrate`).
 */
export async function createDatabase(options: {
  url: string;
  ownerUrl?: string;
  /**
   * DATABASE_MAINTENANCE_URL (workers only): the BYPASSRLS role whose small
   * pool serves `Tenancy.bypass()` and the metrics across tenants.
   */
  maintenanceUrl?: string;
  migrate?: boolean;
  pool?: PoolSettings;
}): Promise<Database> {
  const pool = options.pool;
  if (options.migrate !== false) {
    if (!options.ownerUrl) {
      throw new Error(
        'MIGRATE_ON_START is on, so DATABASE_OWNER_URL is required: the migrations run as the owner of the tables, not as the app (docs/deployment.md, "Database roles"). Or set MIGRATE_ON_START=off and run `node dist/migrate`.',
      );
    }
    await migrateAll({
      ownerUrl: options.ownerUrl,
      appUrl: options.url,
      maintenanceUrl: options.maintenanceUrl,
    });
  }
  registerTenantTables(...tenantTableNames());
  const settings = {
    // Fail fast when the pool is exhausted (503 database_busy), never hang.
    connectionTimeoutMillis: pool?.timeoutMs,
    statement_timeout: pool?.statementTimeoutMs || undefined,
    idle_in_transaction_session_timeout: pool?.idleTxTimeoutMs || undefined,
  };
  const client = new TenantPool(
    {
      connectionString: options.url,
      // Fail fast when the pool is exhausted (503 database_busy), never hang.
      max: pool?.max,
      connectionTimeoutMillis: pool?.timeoutMs,
      // Server-side limits, so a slow query or a forgotten transaction
      // can't hold a connection for ever.
      statement_timeout: pool?.statementTimeoutMs || undefined,
      idle_in_transaction_session_timeout: pool?.idleTxTimeoutMs || undefined,
      // Which process holds a connection, in pg_stat_activity.
      application_name: pool?.applicationName,
    },
    // A few connections: retention sweeps and metrics, one at a time each.
    options.maintenanceUrl
      ? {
          ...settings,
          connectionString: options.maintenanceUrl,
          max: 3,
          application_name: `${pool?.applicationName ?? 'app'}:maintenance`,
        }
      : undefined,
  );
  // Every transaction carries the tenant of its context (core/tenancy/tenant-pool.ts).
  const db = drizzleNodePg({ client, schema });
  return db;
}

/**
 * The secret from `envName`, or one created on the first start with `generate`
 * and kept in `app_secrets`, so it stays the same across restarts.
 */
export async function loadOrCreateSecret(
  db: Database,
  envName: string,
  generate: () => string,
): Promise<string> {
  const configured = process.env[envName];
  if (configured) {
    return configured;
  }
  await db
    .insert(schema.appSecrets)
    .values({ name: envName, value: generate() })
    .onConflictDoNothing();
  const [row] = await db
    .select()
    .from(schema.appSecrets)
    .where(eq(schema.appSecrets.name, envName));
  return row.value;
}

/**
 * The tenant tables of the schema (a `tenant_id` column and row-level
 * security): the strict ones (NOT NULL, reachable only in a tenant's
 * scope) and the optional ones (rows of no tenant too).
 */
export function tenantTableNames(
  tables: Record<string, unknown> = schema,
): [strict: string[], optional: string[]] {
  const strict: string[] = [];
  const optional: string[] = [];
  for (const value of Object.values(tables)) {
    if (!is(value, PgTable)) {
      continue;
    }
    const config = getTableConfig(value);
    const column = config.columns.find((c) => c.name === 'tenant_id');
    if (!column || !config.enableRLS) {
      continue;
    }
    (column.notNull ? strict : optional).push(config.name);
  }
  return [strict, optional];
}
