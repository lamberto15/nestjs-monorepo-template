import { getTableColumns, getTableName } from 'drizzle-orm';
import { type PgColumn, type PgTable, text } from 'drizzle-orm/pg-core';
import { logRedaction } from '../logging/redaction.js';
import type { Normalizer } from './data-cipher.js';

/**
 * The registry of encrypted columns (roadmap item 5, docs/encryption.md):
 * the declaration next to the table is the list. EncryptionService reads it
 * for the binding of each value (its table, column and tenant), the boot
 * check (keys required once a column exists), the re-encryption job and its
 * metric walk it, and the log redaction learns each column's name from it.
 *
 * ```ts
 * export const customers = pgTable('customers', {
 *   id: uuidPk(),
 *   tenantId: tenantColumn(),
 *   taxNumber: encryptedText('tax_number'),
 *   taxNumberIndex: blindIndexText('tax_number_index'),
 *   ...timestamps(),
 * }, (t) => [...tenantTable('customers', t), index('customers_tax_number_idx').on(t.tenantId, t.taxNumberIndex)]).enableRLS();
 *
 * encrypted(customers.taxNumber, { blindIndex: customers.taxNumberIndex, normalize: normalizers.exact });
 * ```
 */

/** A column holding encrypted values (`v1.<key>.<iv>.<ciphertext>.<tag>`, data-cipher.ts). */
export const encryptedText = (name: string) => text(name);

/** A column holding a blind index (`<key>.<mac>`) of an encrypted column. */
export const blindIndexText = (name: string) => text(name);

export interface EncryptedColumnOptions {
  /** The column keeping this one's blind index, for lookups by value. */
  blindIndex?: PgColumn;
  /** How a value is normalized before it is indexed (normalizers in data-cipher.ts); required with `blindIndex`. */
  normalize?: Normalizer;
  /**
   * The `table.column` its values are bound to, when it isn't the
   * column's own: a column renamed after values were written keeps its old
   * name here, or they no longer open (until re-encrypted under the new one).
   */
  aad?: `${string}.${string}`;
}

/** One declared encrypted column. */
export interface EncryptedColumn {
  readonly table: PgTable;
  readonly column: PgColumn;
  /** The column's property in the table's rows (camelCase). */
  readonly key: string;
  /** The table's and column's names the values are bound to. */
  readonly bindingTable: string;
  readonly bindingColumn: string;
  /** Whether rows belong to a tenant (a `tenant_id` column): the binding then names it. */
  readonly tenantScoped: boolean;
  /** The table's primary key `id`, which the re-encryption job pages by. */
  readonly id: PgColumn;
  readonly blindIndex?: {
    readonly column: PgColumn;
    readonly key: string;
    readonly normalize: Normalizer;
  };
}

/** Every declared column, by its Drizzle column object. */
const registry = new Map<PgColumn, EncryptedColumn>();

const propertyOf = (table: PgTable, column: PgColumn) => {
  const entry = Object.entries(getTableColumns(table)).find(
    ([, candidate]) => candidate === column,
  );
  if (!entry) {
    throw new Error(
      `${column.name} is not a column of ${getTableName(table)}.`,
    );
  }
  return entry[0];
};

/**
 * Declares `column` encrypted. Call it at module scope, next to its table
 * (the registry is complete once the schema is imported, before the logger
 * is built: the column's name joins the log redaction).
 */
export function encrypted(
  column: PgColumn,
  options: EncryptedColumnOptions = {},
): EncryptedColumn {
  const table = column.table as PgTable;
  const tableName = getTableName(table);
  const where = `${tableName}.${column.name}`;
  if (registry.has(column)) {
    throw new Error(`${where} is declared encrypted twice.`);
  }
  if (column.getSQLType() !== 'text') {
    throw new Error(`${where}: an encrypted column is text (encryptedText()).`);
  }
  if (options.blindIndex && !options.normalize) {
    throw new Error(
      `${where}: a blind index needs a normalizer (normalizers in core/encryption/data-cipher.ts).`,
    );
  }
  if (options.blindIndex && options.blindIndex.table !== column.table) {
    throw new Error(`${where}: its blind index must be in the same table.`);
  }
  const columns = getTableColumns(table);
  const id = columns.id as PgColumn | undefined;
  if (!id) {
    throw new Error(
      `${where}: an encrypted column's table needs an id column.`,
    );
  }
  const [bindingTable, bindingColumn] = (options.aad ?? where).split('.');
  const key = propertyOf(table, column);
  const entry: EncryptedColumn = {
    table,
    column,
    key,
    bindingTable,
    bindingColumn,
    tenantScoped: Object.values(columns).some(
      (candidate) => candidate.name === 'tenant_id',
    ),
    id,
    blindIndex: options.blindIndex
      ? {
          column: options.blindIndex,
          key: propertyOf(table, options.blindIndex),
          normalize: options.normalize as Normalizer,
        }
      : undefined,
  };
  registry.set(column, entry);
  // Its plaintext, once decrypted, never reaches a log line by its name.
  logRedaction.declareFields(key);
  return entry;
}

/** The declaration of `column`, or an error naming it. */
export function encryptedColumn(column: PgColumn): EncryptedColumn {
  const entry = registry.get(column);
  if (!entry) {
    throw new Error(
      `${getTableName(column.table as PgTable)}.${column.name} is not declared encrypted (encrypted()).`,
    );
  }
  return entry;
}

/** The declaration bound as `table.column` (a job's reference to it), or undefined. */
export const encryptedColumnNamed = (name: string) =>
  [...registry.values()].find(
    (entry) => `${entry.bindingTable}.${entry.bindingColumn}` === name,
  );

/** Whether `column` is declared encrypted. */
export const isEncrypted = (column: PgColumn) => registry.has(column);

/** Every declared encrypted column, in declaration order. */
export const encryptedColumns = (): readonly EncryptedColumn[] => [
  ...registry.values(),
];
