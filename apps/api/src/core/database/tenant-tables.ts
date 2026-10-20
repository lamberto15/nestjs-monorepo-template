import { is } from 'drizzle-orm';
import { getTableConfig, type PgColumn, PgTable } from 'drizzle-orm/pg-core';
import * as schema from '../../schema.js';

/** A table of the app with a `tenant_id`, as a tenant's export reads it. */
export interface TenantTableInfo {
  /** Its SQL name (`audit_log`): the export's `kind`. */
  readonly name: string;
  readonly table: PgTable;
  readonly tenantId: PgColumn;
  /** Its primary key's columns, in order: the keyset a page continues after. */
  readonly key: readonly { property: string; column: PgColumn }[];
  /** Properties never exported: stored secrets' hashes (`tokenHash`, `keyHash`). */
  readonly hidden: readonly string[];
}

/** Hashes of stored credentials: what they protect is never exported. */
const HIDDEN = /(?:Hash|Secret)$|^secret$/;

let cached: readonly TenantTableInfo[] | undefined;

/**
 * Every table of the app (schema.ts, features' included) that carries a
 * `tenant_id`: the tenant tables and the two global ones that name a
 * tenant (memberships, API keys), in the schema's order. Read from the
 * Drizzle declarations, so a feature's new table is in a tenant's export
 * without a line here. Custom: Drizzle lists a table's columns and keys
 * (`getTableConfig`), not which tables a tenant owns.
 */
export function tenantTables(): readonly TenantTableInfo[] {
  if (cached) {
    return cached;
  }
  const found: TenantTableInfo[] = [];
  for (const value of Object.values(schema)) {
    if (!is(value, PgTable)) {
      continue;
    }
    const config = getTableConfig(value);
    const tenantId = config.columns.find(
      (column) => column.name === 'tenant_id',
    );
    if (!tenantId) {
      continue;
    }
    // SQL name → property and column: a composite key's columns are its own objects.
    const columns = new Map(
      Object.entries(value as unknown as Record<string, unknown>)
        .filter(([, column]) => config.columns.includes(column as PgColumn))
        .map(([property, column]) => [
          (column as PgColumn).name,
          { property, column: column as PgColumn },
        ]),
    );
    const keyColumns = config.columns.some((column) => column.primary)
      ? config.columns.filter((column) => column.primary)
      : (config.primaryKeys[0]?.columns ?? []);
    if (keyColumns.length === 0) {
      throw new Error(
        `${config.name} has a tenant_id but no primary key: a tenant's export pages by it.`,
      );
    }
    found.push({
      name: config.name,
      table: value,
      tenantId,
      key: keyColumns.map((column) => columns.get(column.name)!),
      hidden: [...columns.values()]
        .map(({ property }) => property)
        .filter((property) => HIDDEN.test(property)),
    });
  }
  cached = found;
  return found;
}
