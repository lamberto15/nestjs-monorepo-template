import { getTableName, sql } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/node-postgres';
import { tenants } from '../tenancy/tenancy.tables.js';

/**
 * A name the code no longer uses, stored in rows: a text column holding
 * exactly `from`, or a JSON column holding `"from"` as a key or a value
 * anywhere in it (a condition's key, a rule's type).
 */
export interface StoredRename {
  column: PgColumn;
  from: string;
  to: string;
  json?: boolean;
}

/**
 * Rewrites names stored in rows (stored-renames.ts at the app's root) after
 * the migrations, as the owner: data, not schema, so drizzle-kit has no
 * migration for it, and a stale name (a role's `inMyUnits`) would fail
 * every check that reads it. Tenant by tenant, each in its own transaction
 * with the tenant's settings (as TenantPool sends them), so it works under the
 * forced row-level security whether or not the owner is a superuser.
 * Idempotent: only rows still holding the old name change; a second run
 * changes none.
 */
export async function applyStoredRenames(
  url: string,
  renames: readonly StoredRename[],
  log: (line: string) => void = () => {},
) {
  if (renames.length === 0) {
    return;
  }
  const db = drizzle({ connection: url });
  try {
    const all = await db.select({ id: tenants.id }).from(tenants);
    const counts = new Map<StoredRename, number>();
    for (const { id } of all) {
      await db.transaction(async (tx) => {
        // Both settings, as TenantPool sends them: an UPDATE's WHERE reads
        // rows, so the select policy (app.read_tenants) must see them too.
        await tx.execute(
          sql`select set_config('app.tenant_id', ${id}, true), set_config('app.read_tenants', ${id}, true)`,
        );
        for (const rename of renames) {
          const table = sql.identifier(getTableName(rename.column.table));
          const column = sql.identifier(rename.column.name);
          const result = rename.json
            ? await tx.execute(
                sql`update ${table} set ${column} = replace(${column}::text, ${`"${rename.from}"`}, ${`"${rename.to}"`})::jsonb where ${column}::text like ${`%"${rename.from}"%`}`,
              )
            : await tx.execute(
                sql`update ${table} set ${column} = ${rename.to} where ${column} = ${rename.from}`,
              );
          counts.set(
            rename,
            (counts.get(rename) ?? 0) + (result.rowCount ?? 0),
          );
        }
      });
    }
    for (const rename of renames) {
      const changed = counts.get(rename) ?? 0;
      if (changed > 0) {
        log(
          `Stored names: ${getTableName(rename.column.table)}.${rename.column.name} ${rename.from} → ${rename.to} in ${changed} rows.`,
        );
      }
    }
  } finally {
    await db.$client.end();
  }
}
