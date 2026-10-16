import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core';

/**
 * What the platform does for an entity, declared once next to its table
 * and its permissions:
 *
 * ```ts
 * export const NOTE = defineResource({ subject: 'Note', audit: { ignore: ['publishedAt'] } });
 * ```
 *
 * - `audit`: `audit.recordChange(actor, NOTE, { action, id, before, after }, tx)`
 *   writes `note.created` / `note.updated` (only the fields that changed,
 *   from → to) / `note.deleted`, in the change's transaction. Fields the
 *   subject declares `sensitive` are written as `[redacted]`.
 * - Field-level permissions come from the subject's declared `fields`
 *   (definePermissions): `access.redact()` for responses,
 *   `access.forbiddenFields()` for writes.
 * - Filters: `listQuery()` next to it (core/http/list-query.ts).
 */
export interface ResourceDefinition {
  /** The permission subject (definePermissions): `Note`. */
  subject: string;
  /**
   * Record creates, updates and deletes in the audit log. `expand`: fields
   * holding an object (a JSONB column such as `custom`) whose keys an update
   * diffs one by one, as `custom.region: { from, to }`.
   */
  audit: false | { ignore?: readonly string[]; expand?: readonly string[] };
  /**
   * A recycle bin instead of deleting (the table spreads `softDeletable()`):
   * `access.sqlFilter()` leaves deleted rows out of every list, count and
   * export, `access.can()` refuses every action on a deleted record but
   * `restore`, and SoftDeletePurgeJob deletes them for good after
   * `retentionDays` (default SOFT_DELETE_RETENTION_DAYS). Register the
   * resource in `IamModule.forRoot({ resources })`.
   */
  softDelete?: {
    table: PgTable & { deletedAt: AnyPgColumn; id: AnyPgColumn };
    retentionDays?: number;
  };
}

export const defineResource = <T extends ResourceDefinition>(definition: T) =>
  definition;

/** A change to one record, for `AuditService.recordChange()`. */
export type RecordChange = {
  id: string;
} & (
  | { action: 'created'; after: Record<string, unknown> }
  | {
      action: 'updated';
      before: Record<string, unknown>;
      after: Record<string, unknown>;
    }
  | { action: 'deleted'; before: Record<string, unknown> }
  | { action: 'restored'; after: Record<string, unknown> }
);
