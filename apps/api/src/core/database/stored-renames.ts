import { eq, getTableColumns, getTableName, like, sql } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
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
        // The tenant's setting, as TenantPool sends it: the select and
        // update policies both read `app.tenant_id` alone.
        await tx.execute(sql`select set_config('app.tenant_id', ${id}, true)`);
        for (const rename of renames) {
          const { column } = rename;
          const table = column.table as PgTable;
          const key = keyOf(table, column);
          // A JSON column: the quoted name, wherever it sits in the document.
          const result = rename.json
            ? await tx
                .update(table)
                .set({
                  [key]: sql`replace(${column}::text, ${`"${rename.from}"`}, ${`"${rename.to}"`})::jsonb`,
                })
                .where(like(sql`${column}::text`, `%"${rename.from}"%`))
            : await tx
                .update(table)
                .set({ [key]: rename.to })
                .where(eq(column, rename.from));
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

/** The property a column has in its table (`set()` takes properties, not column names). */
function keyOf(table: PgTable, column: PgColumn) {
  const entry = Object.entries(getTableColumns(table)).find(
    ([, candidate]) => candidate === column,
  );
  if (!entry) {
    throw new Error(
      `Stored rename: ${column.name} is not a column of ${getTableName(table)}.`,
    );
  }
  return entry[0];
}
