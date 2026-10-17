import pg from 'pg';
import {
  currentTenantScope,
  scopeOpensTenants,
  TenantScopeMissingError,
  type TenantScope,
  tenantSettingsStatement,
} from './tenant-scope.js';

/**
 * The tables a query may touch only in a tenant's scope, and those whose
 * `tenant_id` may be null (their rows of no tenant are readable outside
 * one): set once at startup from the schema (core/database/drizzle.ts), so
 * this file needs no import of every table.
 */
const registry = {
  strict: new Set<string>(),
  optional: new Set<string>(),
};

export function registerTenantTables(strict: string[], optional: string[]) {
  registry.strict = new Set(strict);
  registry.optional = new Set(optional);
}

/** The tables a statement reads or writes (Drizzle quotes every name). */
const TABLE =
  /\b(?:from|join|into|update)\s+"(?:[a-z0-9_]+"\.")?([a-z0-9_]+)"/gi;

/** The tables of row-level security a statement names: `strict` ones (never without a tenant), and all. */
export function tenantTablesIn(text: string): string[];
export function tenantTablesIn(text: string, which: 'strict' | 'any'): string[];
export function tenantTablesIn(
  text: string,
  which: 'strict' | 'any' = 'strict',
): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(TABLE)) {
    const table = match[1]!;
    if (
      registry.strict.has(table) ||
      (which === 'any' && registry.optional.has(table))
    ) {
      found.push(table);
    }
  }
  return found;
}

/** Whether this process has the maintenance role's pool: `Tenancy.bypass()` and the metrics across tenants work here. */
let maintenanceInProcess = false;
export const maintenanceAvailable = () => maintenanceInProcess;

const BEGIN = /^\s*(?:begin|start\s+transaction)\b/i;
const END = /^\s*(?:commit|rollback|end|abort)\s*;?\s*$/i;

type Callback = (error: Error | null, result?: unknown) => void;
type QueryArgs = [config: unknown, values?: unknown, callback?: unknown];

const textOf = (config: unknown) =>
  typeof config === 'string'
    ? config
    : typeof (config as { text?: unknown } | null)?.text === 'string'
      ? (config as { text: string }).text
      : '';

const withText = (config: unknown, text: string) =>
  typeof config === 'string' ? text : { ...(config as object), text };

/** What a client remembers of the transaction it is in. */
interface TenantClientState {
  /** The scope the open transaction's settings were issued for; undefined outside a transaction. */
  transaction?: TenantScope | null;
}

const STATE = Symbol('tenancy.client');

/**
 * Custom, not a package's: neither node-postgres nor Drizzle nor
 * @nestjs-cls/transactional has a per-transaction hook for session
 * settings, and every transaction, the transaction host's and a store's
 * own `db.transaction()` alike, must carry the tenant (docs/tenancy.md).
 *
 * The pool of api and worker, the app role's. On top of node-postgres' pool:
 *
 * - **Every transaction starts with the tenant's settings.** A client's
 *   `begin` is sent together with `set_config('app.tenant_id' | …, …, true)`
 *   for the scope of the current context (CLS: the request's principal, a
 *   job's envelope, `SystemContext.run(…, { tenantId })`): one round trip,
 *   local to that transaction, gone at its end, so a pooled connection
 *   never carries a tenant into its next use.
 * - **A query outside a transaction that names a tenant table, in a
 *   tenant's scope, gets a transaction of its own**: `begin` with the
 *   settings, the query, `commit`. A query on global tables alone goes
 *   straight through, as it would without tenancy.
 * - **No tenant, no tenant table**: a statement naming one with no tenant
 *   in its context is refused (TenantScopeMissingError) before a client is
 *   checked out, so the refusal never costs a connection. The policies
 *   would read nothing and write nothing (fail closed); this says why.
 * - **The bypass is another role.** In `Tenancy.bypass()`'s scope, queries
 *   and transactions go to the maintenance role's pool (BYPASSRLS,
 *   DATABASE_MAINTENANCE_URL, workers only): an api process holds no
 *   bypass at all, and no setting turns one on. What this does not do:
 *   SQL injected into a request still runs as the app role and may set
 *   `app.tenant_id` / `app.read_tenants` itself (to any tenant ids it can
 *   read, from the global `tenants` table): row-level security bounds an
 *   injection by what those settings allow, not by the request's tenant.
 *   The wall is against bugs in queries, not a substitute for parameters.
 *   Without that pool here, the bypass is refused.
 */
export class TenantPool extends pg.Pool {
  private readonly maintenance?: pg.Pool;

  constructor(config?: pg.PoolConfig, maintenance?: pg.PoolConfig) {
    super(config);
    this.on('connect', (client) => tenantAware(client));
    if (maintenance) {
      this.maintenance = new pg.Pool(maintenance);
      this.maintenance.on('connect', (client) => readOnlyAware(client));
      // A dropped idle connection is the pool's to replace, not a crash.
      this.maintenance.on('error', () => undefined);
      maintenanceInProcess = true;
    }
  }

  /** Whether this pool can serve the bypass (the maintenance role's pool is configured). */
  get bypassAvailable() {
    return !!this.maintenance;
  }

  // The promise form, as Drizzle calls it; the callback form goes through
  // the clients' own wrapper (the refusal, without a transaction of its own).
  override query(...args: unknown[]): never {
    const [config, values, callback] = args as QueryArgs;
    if (typeof values === 'function' || typeof callback === 'function') {
      return (super.query as (...a: unknown[]) => never)(...args);
    }
    const scope = currentTenantScope();
    if (scope?.bypass) {
      const pool = this.maintenancePool();
      return (
        scope.readOnly
          ? inTransaction(() => pool.connect(), config, values)
          : pool.query(config as string, values as [])
      ) as never;
    }
    const text = textOf(config);
    if (tenantTablesIn(text, 'any').length === 0) {
      // Global tables only: no settings to give, nothing to refuse.
      return (super.query as (...a: unknown[]) => never)(config, values);
    }
    if (!scopeOpensTenants(scope)) {
      const strict = tenantTablesIn(text);
      if (strict.length > 0) {
        return Promise.reject(refusal(strict, false)) as never;
      }
      // An optional table (rows of no tenant): as it is, without settings.
      return (super.query as (...a: unknown[]) => never)(config, values);
    }
    return inTransaction(
      () => super.connect() as Promise<pg.PoolClient>,
      config,
      values,
    ) as never;
  }

  // Drizzle's `db.transaction()` checks a client out here: in the bypass's
  // scope, the maintenance role's.
  override connect(...args: unknown[]): never {
    if (currentTenantScope()?.bypass) {
      return (this.maintenancePool().connect as (...a: unknown[]) => never)(
        ...args,
      );
    }
    return (super.connect as (...a: unknown[]) => never)(...args);
  }

  override async end() {
    await Promise.all([super.end(), this.maintenance?.end()]);
  }

  private maintenancePool() {
    if (!this.maintenance) {
      throw new Error(
        'Work across every tenant needs the maintenance role, and this process has none: DATABASE_MAINTENANCE_URL, given to workers only (docs/tenancy.md, "The bypass").',
      );
    }
    return this.maintenance;
  }
}

/** `begin`, the query, `commit` (or `rollback`) on a client `connect` checks out. */
async function inTransaction(
  connect: () => Promise<pg.PoolClient>,
  config: unknown,
  values: unknown,
) {
  const client = await connect();
  let broken: Error | undefined;
  try {
    await client.query('begin');
    try {
      const result = await client.query(config as string, values as []);
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback').catch((rollback: Error) => {
        broken = rollback;
      });
      throw error;
    }
  } finally {
    client.release(broken);
  }
}

const refusal = (tables: string[], outsideTransaction: boolean) =>
  new TenantScopeMissingError(
    `A query on ${[...new Set(tables)].join(', ')} ran without a tenant in its context${outsideTransaction ? ' (outside a transaction, on a client of its own)' : ''}: run it in a request of a tenant, a job restored from its envelope, or SystemContext.run(job, work, { tenantId }) (docs/tenancy.md).`,
  );

/** Wraps a new connection's `query()`: the settings after `begin`, the refusal. */
function tenantAware(client: pg.PoolClient) {
  const target = client as pg.PoolClient & { [STATE]?: TenantClientState };
  if (target[STATE]) {
    return;
  }
  const state: TenantClientState = {};
  target[STATE] = state;
  const query = client.query.bind(client) as (...args: unknown[]) => unknown;
  (client as { query: unknown }).query = (...args: unknown[]) => {
    const [config, values, callback] = args as QueryArgs;
    const text = textOf(config);
    const done =
      typeof values === 'function'
        ? (values as Callback)
        : typeof callback === 'function'
          ? (callback as Callback)
          : undefined;
    if (BEGIN.test(text)) {
      const scope = currentTenantScope();
      if (scope?.bypass) {
        // Never on the app role's connections: TenantPool.connect() hands
        // the bypass the maintenance role's.
        return fail(
          new Error('The bypass runs on the maintenance role, not here.'),
          done,
        );
      }
      state.transaction = scope ?? null;
      if (scopeOpensTenants(scope)) {
        // `begin` takes no parameters, so it is a simple-protocol query, and
        // the settings (literals, checked UUIDs) ride along in the same trip.
        args[0] = withText(
          config,
          `${text.replace(/;\s*$/, '')}; ${scope!.readOnly ? 'set transaction read only; ' : ''}${tenantSettingsStatement(scope!)}`,
        );
      }
      return query(...args);
    }
    if (END.test(text)) {
      // Reset before the statement runs: a failed commit still ends the transaction.
      state.transaction = undefined;
      return query(...args);
    }
    // The settings exist only inside a transaction that began with them:
    // outside one (a client of its own, or the pool without a tenant) a
    // tenant table is never reachable.
    if (!scopeOpensTenants(state.transaction ?? undefined)) {
      const tables = tenantTablesIn(text);
      if (tables.length > 0) {
        return fail(
          refusal(
            tables,
            state.transaction === undefined &&
              scopeOpensTenants(currentTenantScope()),
          ),
          done,
        );
      }
    }
    return query(...args);
  };
}

/** The maintenance role's connections: read-only transactions in the aggregates' scope. */
function readOnlyAware(client: pg.PoolClient) {
  const query = client.query.bind(client) as (...args: unknown[]) => unknown;
  (client as { query: unknown }).query = (...args: unknown[]) => {
    const text = textOf(args[0]);
    if (BEGIN.test(text) && currentTenantScope()?.readOnly) {
      args[0] = withText(
        args[0],
        `${text.replace(/;\s*$/, '')}; set transaction read only`,
      );
    }
    return query(...args);
  };
}

function fail(error: Error, done: Callback | undefined) {
  if (done) {
    queueMicrotask(() => done(error));
    return undefined;
  }
  return Promise.reject(error);
}
