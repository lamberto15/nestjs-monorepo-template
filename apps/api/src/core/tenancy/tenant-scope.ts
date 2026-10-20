import { type SQL, sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  foreignKey,
  pgPolicy,
  type PgPolicy,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { ClsServiceManager } from 'nestjs-cls';
import { tenantClosure, tenants } from './tenancy.tables.js';

/**
 * The tenant the current work runs for (docs/tenancy.md): what the pool
 * hands PostgreSQL as `app.tenant_id` and `app.read_tenants` at the start
 * of every transaction (`set_config(…, true)`: gone at its end), and what
 * the row-level security policies of every tenant table read.
 *
 * - `tenantId`: the one tenant writes go to (`WITH CHECK`), and the one
 *   reads see unless `readTenants` widens it.
 * - `readTenants`: the tenants reads may see (`USING`): the same one; more
 *   only for a consolidated read (roadmap 1b's tenant tree).
 * - `bypass`: every tenant, reads and writes: maintenance jobs that sweep
 *   every tenant's rows at once, in a worker only (`Tenancy.bypass()`).
 *   Not a setting: the pool runs such work as the maintenance role
 *   (BYPASSRLS), which only workers can connect as.
 */
export interface TenantScope {
  readonly tenantId: string | null;
  readonly readTenants: readonly string[];
  readonly bypass: boolean;
  /** Every transaction `READ ONLY` (the aggregates' scope: counts across tenants, nothing written). */
  readonly readOnly?: boolean;
}

/**
 * The CLS key of the scope. A symbol: a dotted string key is a path in
 * nestjs-cls, whose parent object a nested (`inherit`) context shares, so
 * an inner scope would leak out.
 */
export const TENANT_SCOPE = Symbol('tenancy.scope');

/** The scope of one tenant: reads and writes in it alone. */
export const tenantScope = (tenantId: string): TenantScope =>
  Object.freeze({
    tenantId: assertUuid(tenantId),
    readTenants: Object.freeze([tenantId]),
    bypass: false,
  });

/**
 * A consolidated read (docs/tenancy.md, "The tenant tree"): reads see
 * `tenantId` and the descendants given, writes nothing (every transaction
 * `READ ONLY`; the write policies take `tenantId` alone anyway). The
 * descendants come from the tree (TenantTree.consolidated(), after its
 * permission check); the read policies check them against the tree again.
 */
export const consolidatedScope = (
  tenantId: string,
  descendants: readonly string[],
): TenantScope =>
  Object.freeze({
    tenantId: assertUuid(tenantId),
    readTenants: Object.freeze([
      tenantId,
      ...descendants.filter((id) => assertUuid(id) !== tenantId),
    ]),
    bypass: false,
    readOnly: true,
  });

/** No tenant: global tables only; a query on a tenant table is refused (TenantScopeMissingError). */
export const NO_TENANT: TenantScope = Object.freeze({
  tenantId: null,
  readTenants: Object.freeze([]),
  bypass: false,
});

/** Every tenant at once: `Tenancy.bypass()`, a worker's maintenance jobs only. */
export const BYPASS: TenantScope = Object.freeze({
  tenantId: null,
  readTenants: Object.freeze([]),
  bypass: true,
});

/**
 * Every tenant, read only: the deployment-wide gauges of the metrics
 * (`MetricsService.collect(…, { acrossTenants: true })`: open approvals).
 * As the maintenance role, so only where it is (workers); each transaction
 * is `READ ONLY`, so nothing in it can write any tenant's rows, and what it
 * returns is an aggregate, never a tenant's rows.
 */
export const AGGREGATES: TenantScope = Object.freeze({
  tenantId: null,
  readTenants: Object.freeze([]),
  bypass: true,
  readOnly: true,
});

/**
 * Runs `work` in the aggregates' scope (AGGREGATES): metrics across
 * tenants, for `MetricsService.collect(…, { acrossTenants: true })` only.
 * It needs the maintenance role, which only workers hold; a process with
 * `APP_ROLE=all` (development, tests, a small deployment) has it next to
 * its routes, so that process's `/metrics` serves these gauges too:
 * read-only aggregates, never rows. Nothing else calls this.
 */
export function acrossTenantsReadOnly<T>(work: () => Promise<T> | T) {
  const cls = ClsServiceManager.getClsService();
  return cls.run({ ifNested: 'inherit' }, async () => {
    cls.set(TENANT_SCOPE, AGGREGATES);
    return await work();
  });
}

/**
 * The scope of the current context, or undefined outside one (no request,
 * no job): read from CLS through its global manager, so the pool and a
 * column's default reach it without Nest's injection.
 */
export function currentTenantScope(): TenantScope | undefined {
  const cls = ClsServiceManager.getClsService();
  return cls.isActive()
    ? (cls.get(TENANT_SCOPE) as TenantScope | undefined)
    : undefined;
}

/** The tenant of the current context, or null (none, or the bypass). */
export const currentTenantId = () => currentTenantScope()?.tenantId ?? null;

/** Whether the scope opens any tenant: one (settings the policies read), or every one (the bypass). */
export const scopeOpensTenants = (scope: TenantScope | undefined) =>
  !!scope && (scope.bypass || !!scope.tenantId || scope.readTenants.length > 0);

/** The tenant writes go to, or a TenantScopeMissingError. */
export function requireTenantId(where = 'This write'): string {
  const tenantId = currentTenantId();
  if (!tenantId) {
    throw new TenantScopeMissingError(
      `${where} needs a tenant, and the context has none: run it in a request of a tenant, a job restored from its envelope, or SystemContext.run(job, work, { tenantId }).`,
    );
  }
  return tenantId;
}

/**
 * Work on a tenant table without a tenant in the context. Thrown by the
 * pool before such a query is sent (every environment: the policies would
 * answer it with nothing, and a request would show an empty page rather
 * than fail), and by an insert whose `tenant_id` nothing provided. Over
 * HTTP it is 403 `tenant_required`: the caller has no tenant (a user with
 * no membership, a session whose tenant was left).
 */
export class TenantScopeMissingError extends Error {
  override readonly name = 'TenantScopeMissingError';
}

/** A UUID as PostgreSQL writes them: what the policies compare `tenant_id` with. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function assertUuid(value: string) {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new TypeError(`Not a tenant id: ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * The statement that sets the two settings for the rest of the transaction
 * (`set_config(…, true)` is `SET LOCAL`: gone at commit or rollback, never
 * left on a pooled connection). Literal values, so it can follow `begin` in
 * one simple-protocol round trip; each is a UUID checked here, never text
 * from outside.
 */
export function tenantSettingsStatement(scope: TenantScope) {
  const tenantId = scope.tenantId ? assertUuid(scope.tenantId) : '';
  const readTenants = scope.readTenants.map(assertUuid).join(',');
  return `select set_config('app.tenant_id', '${tenantId}', true), set_config('app.read_tenants', '${readTenants}', true)`;
}

/**
 * The `tenant_id` column of a tenant table: NOT NULL, no database default
 * (a raw insert must say the tenant), referencing `tenants`. Drizzle fills
 * it from the context when an insert leaves it out, and refuses when there
 * is none (TenantScopeMissingError): a forgotten tenant fails instead of
 * landing in a default one, and the `WITH CHECK` policy proves the value
 * is the context's. With `tenantTable()` in the table's extras and
 * `.enableRLS()` on it:
 *
 * ```ts
 * export const invoices = pgTable('invoices', { id: uuidPk(), tenantId: tenantColumn(), … },
 *   (t) => [...tenantTable('invoices', t), index('invoices_tenant_number_idx').on(t.tenantId, t.number)],
 * ).enableRLS();
 * ```
 */
export const tenantColumn = () =>
  uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' })
    .$defaultFn(() => requireTenantId('An insert'));

/**
 * A `tenant_id` that may be null: rows of no tenant (an account's own
 * security events, written before any tenant is chosen). Only the tables
 * `tenantPolicies(…, { nullRows })` declares so; filled from the context
 * when there is a tenant, else null.
 */
export const optionalTenantColumn = () =>
  uuid('tenant_id')
    .references(() => tenants.id, { onDelete: 'cascade' })
    // Null (no tenant) is what the column allows; Drizzle's type wants a value.
    .$defaultFn(() => currentTenantId() as string);

/** The tenant writes go to, null when unset or empty. */
const writeTenant = sql`(select nullif(current_setting('app.tenant_id', true), '')::uuid)`;
/**
 * The tenants reads see, `{}` when unset or empty. The cast outside makes
 * the subquery one value (an array, read once: an InitPlan); `any((select
 * …))` alone would compare with each of its rows.
 */
const readTenants = sql`(select string_to_array(coalesce(current_setting('app.read_tenants', true), ''), ',')::uuid[])::uuid[]`;
/**
 * The descendants of `app.tenant_id` in the tenant tree (`tenant_closure`),
 * `{}` for a tenant with none (every tenant outside a holding): uncorrelated,
 * so read once per statement (an InitPlan), as the settings are.
 */
const subtree = sql`array(select ${tenantClosure.descendantId} from ${tenantClosure} where ${tenantClosure.ancestorId} = ${writeTenant})`;

/**
 * Who sees the rows without a tenant of a table whose `tenant_id` may be
 * null: `outside` (the audit log) only work outside any tenant (a sign-in,
 * an account's own data), so no tenant's administrator reads another
 * person's sign-ins; `everywhere` (notifications) every context, the code
 * filtering by recipient as it always does.
 */
export type NullRows = 'outside' | 'everywhere';

/**
 * The policies of a tenant table, declared with the table so drizzle-kit
 * emits them (`pnpm db:generate`: `CREATE POLICY` and `ENABLE ROW LEVEL
 * SECURITY`); `FORCE ROW LEVEL SECURITY`, and the check that every table
 * with a `tenant_id` has all of it, are the role bootstrap's
 * (core/database/roles.ts), as drizzle-kit emits no FORCE.
 *
 * Reads see the rows of `app.read_tenants` that are `app.tenant_id`'s own
 * or its descendants' in the tenant tree (`tenant_closure`: a consolidated
 * read, roadmap 1b); writes go to `app.tenant_id`
 * alone (an update may not move a row to another tenant: its `WITH CHECK`
 * reads the same setting); a delete takes `app.tenant_id`'s rows. There
 * is no bypass clause: the worker's sweeps across tenants run as the
 * maintenance role, which has BYPASSRLS. Every setting is read once per statement
 * through a `(select current_setting(…))` subquery. Unset or empty
 * settings match nothing: a connection without a tenant reads and writes
 * no row of these tables (the pool refuses such a query before sending it,
 * TenantScopeMissingError, so this is the second wall, not the message).
 */
export function tenantPolicies(
  table: string,
  tenantId: AnyPgColumn,
  options: { nullRows?: NullRows } = {},
): PgPolicy[] {
  const column = sql`${tenantId}`;
  const nullable = options.nullRows;
  const readNull: SQL | undefined =
    nullable === 'everywhere'
      ? sql`${column} is null`
      : nullable === 'outside'
        ? sql`(${column} is null and ${writeTenant} is null)`
        : undefined;
  // A read tenant counts only when it is `app.tenant_id` or one of its
  // descendants: a consolidated read (`app.read_tenants` widened to the
  // subtree) never reaches a parent or a sibling, even when the setting
  // names one (a bug, a forged value): the tree is the database's.
  const own = sql`(${column} = ${writeTenant} or ${column} = any(${subtree}))`;
  const read = sql`((${column} = any(${readTenants}) and ${own})${readNull ? sql` or ${readNull}` : sql``})`;
  const write = sql`(${column} = ${writeTenant})`;
  // Rows of no tenant are written where they are read: outside a tenant
  // (the audit log's), or anywhere (a person's own notifications, marked
  // read from whichever tenant they are in).
  const writeNull =
    nullable === 'everywhere'
      ? sql`${column} is null`
      : sql`(${column} is null and ${writeTenant} is null)`;
  const nullableWrite = sql`(${column} = ${writeTenant} or ${writeNull})`;
  const writes = nullable ? nullableWrite : write;
  return [
    pgPolicy(`${table}_tenant_select`, { for: 'select', using: read }),
    pgPolicy(`${table}_tenant_insert`, { for: 'insert', withCheck: writes }),
    pgPolicy(`${table}_tenant_update`, {
      for: 'update',
      using: writes,
      withCheck: writes,
    }),
    pgPolicy(`${table}_tenant_delete`, { for: 'delete', using: writes }),
  ];
}

/**
 * What every tenant table declares in its extras: its policies, and, for a
 * table other tenant tables' keys point at (`{ referenced: true }`), a
 * unique `(tenant_id, id)`, which their composite foreign keys need
 * (`tenantReference()`). Only those: a unique index elsewhere would cost
 * every insert for nothing.
 */
export function tenantTable(
  table: string,
  columns: { tenantId: AnyPgColumn; id?: AnyPgColumn },
  options: { nullRows?: NullRows; referenced?: boolean } = {},
) {
  if (options.referenced && !columns.id) {
    throw new Error(`${table}: a referenced tenant table needs an id column.`);
  }
  return [
    ...tenantPolicies(table, columns.tenantId, options),
    ...(options.referenced && columns.id
      ? [unique(`${table}_tenant_id_id_key`).on(columns.tenantId, columns.id)]
      : []),
  ];
}

/**
 * A foreign key within one tenant: `(tenant_id, x_id)` → `(tenant_id, id)`
 * of the referenced tenant table. A plain `x_id → id` key passes row-level
 * security (PostgreSQL checks keys as the table's owner), so a row could
 * point at another tenant's; the composite key can't.
 */
export function tenantReference(
  name: string,
  columns: [tenantId: AnyPgColumn, column: AnyPgColumn],
  foreign: [tenantId: AnyPgColumn, id: AnyPgColumn],
  onDelete: 'cascade' | 'restrict' | 'set null' | 'no action' = 'cascade',
) {
  const key = foreignKey({
    name,
    columns,
    foreignColumns: foreign,
  });
  // `set null` names the referring column alone (PostgreSQL 15+): the
  // tenant stays, as it is NOT NULL. drizzle-kit writes the action as given.
  return key.onDelete(
    onDelete === 'set null'
      ? (`set null ("${columns[1].name}")` as 'set null')
      : onDelete,
  );
}

/**
 * A key of the current tenant (`tenant:<id>:<key>`): what per-principal
 * keys become (idempotency scopes, cache entries, Redis counters), so the
 * same principal key in two tenants (a user in both) never shares one.
 * Built in the platform code, never at call sites.
 */
export const tenantKey = (key: string, tenantId = requireTenantId()) =>
  `tenant:${tenantId}:${key}`;
