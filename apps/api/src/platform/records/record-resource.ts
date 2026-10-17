import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core';
import {
  defineResource,
  type ResourceDefinition,
} from '../../iam/resources/resource.js';
import { type RecordDeclaration, takes } from './record.js';

/**
 * A record's resource (defineResource), from its declaration (record.ts):
 * every change audited, the search vector left out of the entries (it
 * follows the text), a custom value's change as `custom.<key>` (custom),
 * and with `softDelete` the recycle bin (lists leave
 * deleted ones out, SoftDeletePurgeJob purges them). `options` replaces
 * the audit settings or sets the bin's retention.
 *
 * ```ts
 * export const INVOICE_RESOURCE = recordResource(INVOICE, invoices);
 * ```
 */
export function recordResource(
  declaration: RecordDeclaration,
  table: PgTable,
  options: { audit?: ResourceDefinition['audit']; retentionDays?: number } = {},
): ResourceDefinition {
  return defineResource({
    subject: declaration.subject,
    audit: options.audit ?? {
      ignore: ['search'],
      ...(takes(declaration, 'custom') && { expand: ['custom'] }),
    },
    ...(declaration.softDelete && {
      softDelete: {
        table: table as PgTable & { deletedAt: AnyPgColumn; id: AnyPgColumn },
        ...(options.retentionDays && { retentionDays: options.retentionDays }),
      },
    }),
  });
}
