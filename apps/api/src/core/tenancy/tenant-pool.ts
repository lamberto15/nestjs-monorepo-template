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

/** The strict tenant tables a statement names: what may not run without a tenant. */
export function tenantTablesIn(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(TABLE)) {
    if (registry.strict.has(match[1])) {
      found.push(match[1]);
    }
  }
  return found;
}

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
 * The pool of api and worker. Two things on top of node-postgres' pool:
 *
 * - **Every transaction starts with the tenant's settings.** A client's
 *   `begin` is sent together with `set_config('app.tenant_id' | …, …, true)`
 *   for the scope of the current context (CLS: the request's principal, a
 *   job's envelope, `SystemContext.run(…, { tenantId })`): one round trip,
 *   local to that transaction, gone at its end, so a pooled connection
 *   never carries a tenant into its next use.
 * - **A query outside a transaction, in a tenant's scope, gets one of its
 *   own**: `begin` with the settings, the query, `commit`. Reads through
 *   `database(txHost)` outside `inTransaction()` keep working, each in a
 *   short transaction (two extra round trips), never with a connection
 *   held across a request's other awaits.
 *
 * And one refusal, in every environment: a statement naming a tenant table
 * with no tenant in its context (outside a transaction, or in one that
 * started without a tenant) fails with TenantScopeMissingError before it
 * is sent. The policies would read nothing and write nothing (fail
 * closed); this says why, loudly.
 */
export class TenantPool extends pg.Pool {
  constructor(config?: pg.PoolConfig) {
    super(config);
    this.on('connect', (client) => tenantAware(client));
  }

  // The promise form, as Drizzle calls it; the callback form goes through
  // the clients' own wrapper (the check, without a transaction of its own).
  override query(...args: unknown[]): never {
    const [config, values, callback] = args as QueryArgs;
    if (typeof values === 'function' || typeof callback === 'function') {
      return (super.query as (...a: unknown[]) => never)(...args);
    }
    const scope = currentTenantScope();
    if (!scopeOpensTenants(scope)) {
      return (super.query as (...a: unknown[]) => never)(config, values);
    }
    return this.inTransaction(config, values) as never;
  }

  private async inTransaction(config: unknown, values: unknown) {
    const client = await this.connect();
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
}

/** Wraps a new connection's `query()`: the settings after `begin`, the refusal. */
function tenantAware(client: pg.PoolClient) {
  const state: TenantClientState = {};
  const target = client as pg.PoolClient & { [STATE]?: TenantClientState };
  if (target[STATE]) {
    return;
  }
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
      state.transaction = scope ?? null;
      if (scopeOpensTenants(scope)) {
        // `begin` takes no parameters, so it is a simple-protocol query, and
        // the settings (literals, checked UUIDs) ride along in the same trip.
        args[0] = withText(
          config,
          `${text.replace(/;\s*$/, '')}; ${tenantSettingsStatement(scope!)}`,
        );
      }
      return query(...args);
    }
    if (END.test(text)) {
      state.transaction = undefined;
      return query(...args);
    }
    // The settings exist only inside a transaction that began with them:
    // outside one (a client of its own, or the pool without a tenant) a
    // tenant table is never reachable.
    if (!scopeOpensTenants(state.transaction ?? undefined)) {
      const tables = tenantTablesIn(text);
      if (tables.length > 0) {
        const error = new TenantScopeMissingError(
          `A query on ${[...new Set(tables)].join(', ')} ran without a tenant in its context${state.transaction === undefined && scopeOpensTenants(currentTenantScope()) ? ' (outside a transaction, on a client of its own)' : ''}: run it in a request of a tenant, a job restored from its envelope, or SystemContext.run(job, work, { tenantId }) (docs/tenancy.md).`,
        );
        if (done) {
          queueMicrotask(() => done(error));
          return undefined;
        }
        return Promise.reject(error);
      }
    }
    return query(...args);
  };
}
