import { sql } from 'drizzle-orm';
import { jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { timestamps, uuidPk } from '../../core/database/columns.js';
import { tenantColumn, tenantTable } from '../../core/tenancy/tenant-scope.js';
import type { ImportMapping } from './import-mapping.js';

/**
 * Column mappings kept under a name for an import (docs/data-transfer.md,
 * "Column mappings"): which header of a spreadsheet fills which column of
 * the template. The tenant's, for whoever may run that import; checked
 * again against the importer's schema and the caller's field permissions
 * whenever one is used.
 */
export const importMappings = pgTable(
  'import_mappings',
  {
    id: uuidPk(),
    tenantId: tenantColumn(),
    /** The importer's name: `notes`. */
    importer: text('importer').notNull(),
    name: text('name').notNull(),
    /** The file header to the template column (null: ignored). */
    mapping: jsonb('mapping').$type<ImportMapping>().notNull(),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('import_mappings_name_idx').on(
      table.tenantId,
      table.importer,
      sql`lower(${table.name})`,
    ),
    ...tenantTable('import_mappings', table),
  ],
).enableRLS();

export type ImportMappingRow = typeof importMappings.$inferSelect;
