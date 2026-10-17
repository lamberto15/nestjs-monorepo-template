import type { TenantEnvelope } from '../../core/tenancy/tenant-job.js';
import type { z } from 'zod';
import type { Principal, RequestPrincipal } from '../../iam/auth/principal.js';

/** Ids one request may name; more: a `filter`. */
export const MAX_BULK_IDS = 500;
/** Item results a queued job keeps (its counts are exact). */
export const MAX_BULK_RESULTS = 10_000;

/** One action of a bulk operation: `delete`, `restore`, `update`… */
export interface BulkAction {
  label: string;
  /** The permission it takes on the operation's subject (`delete`). */
  permission: string;
  /** Its input (`update`: the PATCH body), checked once for every item; none: it takes none. */
  input?: z.ZodType;
}

/** What a run acts on: these ids, or every record matching the list's filters. */
export interface BulkSelection {
  ids?: string[];
  filter?: Record<string, unknown>;
}

/**
 * What a feature implements to let clients act on many of its records at
 * once (POST /<x>/bulk). Register it from its constructor:
 * `registry.register(this)`.
 *
 * ```ts
 * @Injectable()
 * export class NoteBulk implements BulkOperation<Note> {
 *   readonly name = 'notes';
 *   readonly subject = 'Note';
 *   readonly actions = { delete: { label: 'Delete', permission: 'delete' } };
 *   readonly filters = NOTE_LIST.schema;         // the list's own filters
 *   async *select(principal, action, selection) { … yield rows (keyset) … }
 *   async perform(principal, action, note, input, ip) { await this.notes.delete(principal, note, ip); }
 * }
 * ```
 */
export interface BulkOperation<Row extends { id: string } = { id: string }> {
  /** The name the feature's route runs it by: `bulk.run(user, { name: 'notes', … })`. */
  readonly name: string;
  /** The permission subject; the caller needs each action's permission on it. */
  readonly subject: string;
  readonly actions: Readonly<Record<string, BulkAction>>;
  /** The list's filter schema (`NOTE_LIST.schema`): what a `filter` selection takes. None: ids only. */
  readonly filters?: z.ZodType<Record<string, unknown>>;
  /**
   * The records the principal may `action` among `selection.ids`, or all
   * those matching `selection.filter` (already parsed by `filters`): in the
   * query (`access.sqlFilter()`), in batches, keyset by id (never an
   * offset: the action may change what matches). An id it doesn't yield is
   * reported as skipped (`not_found`).
   */
  select(
    principal: Principal,
    action: string,
    selection: BulkSelection,
  ): AsyncIterable<Row[]>;
  /**
   * One item, as the feature's own route does it: the record check, the
   * field-level check, the same service call (its transaction and audit
   * entry). A 4xx it throws fails that item alone; anything else stops the run.
   */
  perform(
    principal: Principal,
    action: string,
    record: Row,
    input: unknown,
    ip?: string,
  ): Promise<void>;
}

/** Why an item failed: the problem its own route would have answered. */
export interface BulkItemError {
  code: string;
  message: string;
  errors?: { path: string; message: string }[];
}

/** What happened to one record. */
export type BulkItemResult =
  | { id: string; status: 'done' }
  | { id: string; status: 'failed' | 'skipped'; error: BulkItemError };

/** A run's outcome: exact counts, the items' results (a queued job keeps MAX_BULK_RESULTS). */
export interface BulkResult {
  done: number;
  failed: number;
  skipped: number;
  results: BulkItemResult[];
  /** More results than were kept. */
  truncated?: boolean;
}

/**
 * A queued run (the `bulk` queue). The selection and input travel raw:
 * parsed again by the worker. It names the tenant it was started in
 * (TenantEnvelope, docs/tenancy.md): the worker runs it there and nowhere
 * else.
 */
export interface BulkJob extends TenantEnvelope {
  readonly tenantId: string;
  /** Never the system principal: a queued job's principal is data (docs/permissions.md). */
  principal: RequestPrincipal;
  name: string;
  action: string;
  ids?: string[];
  filter?: Record<string, unknown>;
  input?: unknown;
  ip?: string;
}
