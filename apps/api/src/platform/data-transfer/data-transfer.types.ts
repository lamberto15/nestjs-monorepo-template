import type { z } from 'zod';
import type { TenantEnvelope } from '../../core/tenancy/tenant-job.js';
import type { Principal, RequestPrincipal } from '../../iam/auth/principal.js';

/** The file formats exports write and imports read. */
export const TRANSFER_FORMATS = ['csv', 'json', 'xlsx'] as const;
export type TransferFormat = (typeof TRANSFER_FORMATS)[number];

/** A column of an export: the record's field, and its header (default: the field). */
export interface TransferColumn {
  key: string;
  header?: string;
  /**
   * `datetime`: a moment. CSV and Excel show it as the reader's local time
   * (`2026-10-15 18:30:00`, Excel's a date cell) under a header naming the
   * zone, `createdAt (Asia/Dubai)`; JSON as ISO 8601 with the offset.
   * `date`: a calendar day, `2026-10-15`: a date cell in Excel, the text
   * in CSV and JSON.
   */
  type?: 'datetime' | 'date';
  /** Reads the cell when it isn't `row[key]` (a custom field: `row.custom.region`). */
  value?: (row: Record<string, unknown>) => unknown;
}

/**
 * What a feature implements to let users export its records. Register it
 * from its constructor: `registry.registerExporter(this)`.
 *
 * ```ts
 * @Injectable()
 * export class NoteTransfer implements DataExporter<Note> {
 *   readonly name = 'notes';
 *   readonly subject = 'Note';
 *   readonly columns = [{ key: 'id' }, { key: 'title' }, { key: 'body' }];
 *   readonly filters = NOTE_LIST.schema;        // the list's own filters
 *   async *batches(principal, filters) { … yield rows; … }
 * }
 * ```
 */
export interface DataExporter<
  Row extends Record<string, unknown> = Record<string, unknown>,
> {
  /** The name clients ask for: `POST /data/exports { name: 'notes' }`. */
  readonly name: string;
  /** The permission subject; the caller needs `action` on it (default `read`). */
  readonly subject: string;
  readonly action?: string;
  /**
   * Replaces the permission check, for an export of the caller's own
   * records (their notifications): `subject` then only names them.
   */
  allowed?(principal: Principal): Promise<boolean> | boolean;
  /**
   * `account`: a person's own export across their tenants (the account
   * export): queued with no tenant (`tenantId: null`), its file under
   * `accounts/<user id>/`, visible to that user in any tenant or none
   * (docs/tenancy.md). Users only. Unset: the caller's tenant's.
   */
  readonly scope?: 'account';
  readonly columns: readonly TransferColumn[];
  /**
   * The columns of one export, when they change at runtime (custom fields):
   * read when the export starts, used instead of `columns`.
   */
  columnsFor?(principal: Principal): Promise<readonly TransferColumn[]>;
  /** The filters the export accepts (a listQuery schema), validated before the job starts. */
  readonly filters?: z.ZodType<Record<string, unknown>>;
  /**
   * The records the principal may read, in batches (keyset pagination: never
   * an offset). Fields the principal may not read are removed afterwards.
   */
  batches(
    principal: Principal,
    filters: Record<string, unknown>,
  ): AsyncIterable<Row[]>;
}

/**
 * A column of an import file, as its template and the catalog describe it.
 * Read from the importer's row schema (`templateColumns` to add more), so
 * what a template shows is what the rows are checked against.
 */
export interface ImportColumn {
  /** The header (a `datetime` column's gets the zone: `dueAt (Asia/Dubai)`). */
  name: string;
  type: 'text' | 'number' | 'boolean' | 'date' | 'datetime' | 'list';
  required: boolean;
  description?: string;
  /** The values allowed (one, or several for a list): Excel gets a dropdown. */
  options?: string[];
  /** Length for text, value for a number, entries for a list. */
  min?: number;
  max?: number;
  example?: unknown;
}

/**
 * What a feature implements to let users import records. Register it from
 * its constructor: `registry.registerImporter(this)`.
 *
 * Each row is treated as one `POST` of the feature: the schema, then the
 * field-level permissions (the platform checks both), then `write()`, whose
 * 4xx refuses that row alone.
 */
export interface DataImporter<Row = Record<string, unknown>> {
  readonly name: string;
  /** The caller needs `action` (default `create`) on `subject`. */
  readonly subject: string;
  readonly action?: string;
  /**
   * One row, validated (files bring strings: coerce numbers, dates, booleans).
   * A row that fails is reported with its number, field and message.
   */
  readonly schema: z.ZodType<Row>;
  /**
   * The row schema of one import, when it changes at runtime (custom
   * fields): read once when the import starts, used instead of `schema`.
   */
  schemaFor?(principal: Principal): Promise<z.ZodType<Row>>;
  /**
   * The file's columns, for the template and the catalog, when they aren't
   * all in `schema` (a z.object; custom fields: `custom.<key>`).
   */
  templateColumns?(principal: Principal): Promise<readonly ImportColumn[]>;
  /**
   * The file's columns no row could pass (a custom field that no longer
   * exists): checked once on the headers, before any row; the import fails
   * naming them, instead of refusing every row. Other columns the schema
   * doesn't name (an export's `id`) are ignored.
   */
  refusedColumns?(
    principal: Principal,
    headers: readonly string[],
  ): Promise<readonly string[]>;
  /**
   * Writes one valid row, as the principal, the way the feature's `POST`
   * does (the same service call). Nest's 4xx exceptions refuse the row and
   * are reported with it; anything else fails the import.
   */
  write(principal: Principal, row: Row): Promise<void>;
}

/**
 * What a transfer job carries: the tenant it was started in, by type
 * (TenantEnvelope, docs/tenancy.md; the worker restores it before any
 * query), and the work. `null` only for an account export
 * (`DataExporter.scope: 'account'`): a person's, in no tenant.
 */
export type TransferJob = TenantEnvelope &
  (
    | {
        kind: 'export';
        name: string;
        format: TransferFormat;
        /** The filters as the caller sent them; the worker parses them with `exporter.filters`. */
        filters: Record<string, unknown>;
        /** The file's time zone, when the caller chose one; else theirs, else APP_TIMEZONE. */
        timezone?: string;
        /** Who asked for it in code (`report:<id>`): handed back to `onFinished` listeners. */
        tag?: string;
        /** Never the system principal: a queued job's principal is data (docs/permissions.md). */
        principal: RequestPrincipal;
      }
    | {
        kind: 'import';
        name: string;
        format: TransferFormat;
        /** The uploaded file, on the private disk; deleted once read. */
        key: string;
        dryRun: boolean;
        principal: RequestPrincipal;
      }
  );

/** One row an import refused. */
export interface ImportRowError {
  /** The row's number in the file (1: the first after the header). */
  row: number;
  path: string;
  message: string;
}

/**
 * A transfer that finished, as `DataTransferRegistry.onFinished` listeners
 * hear it, on the worker that ran it: completed with its result, or failed
 * for good (no attempt left) with the reason.
 */
export type TransferFinished =
  | {
      id: string;
      job: TransferJob;
      status: 'completed';
      result: TransferResult;
    }
  | { id: string; job: TransferJob; status: 'failed'; error: string };

export type TransferResult =
  | { kind: 'export'; key: string; rows: number }
  | {
      kind: 'import';
      rows: number;
      imported: number;
      failed: number;
      dryRun: boolean;
      /** The error report (CSV), when some rows failed. */
      errorsKey?: string;
    };
