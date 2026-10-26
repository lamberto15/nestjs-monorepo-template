import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import type { Transaction } from '../../core/database/drizzle.js';
import {
  database,
  type DrizzleTransactions,
} from '../../core/database/transactions.js';
import type { ListQuery } from '../../core/http/list-query.js';
import {
  afterCursor,
  countPage,
  pageOffset,
  pageOrder,
  toPage,
} from '../../core/http/pagination.js';
import { withoutEncrypted } from '../../core/encryption/encrypted-columns.js';
import { diffFields } from '../../iam/audit/audit.service.js';
import {
  type Principal,
  principalKey,
  type UserPrincipal,
} from '../../iam/auth/principal.js';
import { RecordPurgeRegistry } from '../../iam/resources/record-purge.registry.js';
import {
  PersonalDataRegistry,
  type PersonalDataSource,
} from '../account/personal-data.registry.js';
import { PeopleService } from '../people/people.service.js';
import type { RecordRef } from '../subscriptions/subscriptions.service.js';
import { REVISION_LIST } from './revision.list.js';
import type { RevisionView } from './revision.schemas.js';
import {
  type RevisionItem,
  RevisionsRegistry,
  type RevisionTarget,
} from './revisions.registry.js';
import { revisions } from './revisions.tables.js';

type Revision = typeof revisions.$inferSelect;
type Snapshot = Record<string, unknown>;

/** Who changed a record, once their account was deleted. */
export const ANONYMIZED_CHANGER = 'anonymized';
/** Who wrote a record's state from before it kept revisions: not known. */
export const UNKNOWN_CHANGER = 'unknown';

/**
 * Record revisions: each saved state of a record, numbered per record,
 * with what changed. A feature registers its records (`RevisionsRegistry`,
 * a `RevisionTarget`) and calls `record(tx, …)` in the transaction of its
 * create (revision 1, so the first state can be restored too) and of each
 * update. Whoever may read the record reads its revisions; whoever may
 * change it restores one, through the feature's own update: audited as any
 * change, and a new revision marked `restoredFrom`.
 */
@Injectable()
export class RevisionsService implements PersonalDataSource {
  readonly name = 'revisions';

  /** The current transaction, or the database outside one (core/database/transactions.ts). */
  private get db() {
    return database(this.txHost);
  }

  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly registry: RevisionsRegistry,
    private readonly people: PeopleService,
    personalData: PersonalDataRegistry,
    purges: RecordPurgeRegistry,
  ) {
    personalData.register(this);
    // A record purged from its recycle bin: its revisions go with it.
    purges.register({
      name: 'revisions',
      forget: (tx, subject, ids) => this.forgetAll(tx, subject, ids),
    });
  }

  /**
   * In the change's transaction: the record's next revision, holding
   * `snapshot` (its changeable fields after the change) and what changed
   * since the last one. Nothing when nothing changed (null). On create,
   * revision 1 (no `changes`). An update passes `before` (the fields before
   * the change): a record that has no revision yet (written before its
   * feature kept them) first gets revision 1 from it (by `unknown`, no
   * `changes`), so its state before the first tracked change stays
   * restorable.
   */
  async record(
    tx: Transaction,
    subject: string,
    recordId: string,
    {
      snapshot,
      before,
      by,
      restoredFrom,
    }: {
      snapshot: Snapshot;
      before?: Snapshot;
      by: Principal;
      restoredFrom?: number;
    },
  ): Promise<Revision | null> {
    // Encrypted columns (core/encryption) are never kept in a revision, not
    // even as ciphertext: a restore leaves them as they are.
    snapshot = withoutEncrypted(snapshot);
    before = before && withoutEncrypted(before);
    // Two changes of one record at once take their numbers in turn (until
    // the commit); the unique index is the invariant either way.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`revisions:${subject}:${recordId}`}, 0))`,
    );
    const [last] = await tx
      .select({ number: revisions.number, snapshot: revisions.snapshot })
      .from(revisions)
      .where(this.of({ subject, recordId }))
      .orderBy(desc(revisions.number))
      .limit(1);
    let previous = last;
    if (!previous && before) {
      [previous] = await tx
        .insert(revisions)
        .values({
          subject,
          recordId,
          number: 1,
          snapshot: before,
          changes: null,
          changedBy: UNKNOWN_CHANGER,
        })
        .returning({
          number: revisions.number,
          snapshot: revisions.snapshot,
        });
    }
    const changes = previous ? diff(previous.snapshot, snapshot) : null;
    if (changes && Object.keys(changes).length === 0) {
      return null; // the same state: nothing to keep
    }
    const [row] = await tx
      .insert(revisions)
      .values({
        subject,
        recordId,
        number: (previous?.number ?? 0) + 1,
        snapshot,
        changes,
        restoredFrom: restoredFrom ?? null,
        changedBy: principalKey(by),
      })
      .returning();
    return row!;
  }

  /** Saves a group's revisions in grouped reads/inserts; revision 1 for new records takes no advisory lock. */
  async recordMany(
    tx: Transaction,
    subject: string,
    items: readonly {
      recordId: string;
      snapshot: Snapshot;
      before?: Snapshot;
      by: Principal;
      restoredFrom?: number;
    }[],
  ) {
    if (!items.length) return;
    const ids = items.map(({ recordId }) => recordId);
    const updates = items.filter(({ before }) => before !== undefined);
    if (updates.length) {
      // One statement obtains the same per-record serialization locks as record(), for updates only.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`revisions:${subject}:`} || id::text, 0)) from unnest(array[${sql.join(
          updates.map((item) => sql`${item.recordId}::uuid`),
          sql`, `,
        )}]) as ids(id)`,
      );
    }
    const latest = await tx
      .selectDistinctOn([revisions.recordId], {
        recordId: revisions.recordId,
        number: revisions.number,
        snapshot: revisions.snapshot,
      })
      .from(revisions)
      .where(
        and(eq(revisions.subject, subject), inArray(revisions.recordId, ids)),
      )
      .orderBy(revisions.recordId, desc(revisions.number));
    const previous = new Map(latest.map((row) => [row.recordId, row]));
    const insert: (typeof revisions.$inferInsert)[] = [];
    for (const item of items) {
      const snapshot = withoutEncrypted(item.snapshot);
      const before = item.before && withoutEncrypted(item.before);
      let last = previous.get(item.recordId);
      if (!last && before) {
        insert.push({
          subject,
          recordId: item.recordId,
          number: 1,
          snapshot: before,
          changes: null,
          changedBy: UNKNOWN_CHANGER,
        });
        last = { number: 1, snapshot: before, recordId: item.recordId };
      }
      const changes = last ? diff(last.snapshot, snapshot) : null;
      if (changes && Object.keys(changes).length === 0) continue;
      insert.push({
        subject,
        recordId: item.recordId,
        number: (last?.number ?? 0) + 1,
        snapshot,
        changes,
        restoredFrom: item.restoredFrom ?? null,
        changedBy: principalKey(item.by),
      });
    }
    if (insert.length) await tx.insert(revisions).values(insert);
  }

  /** A page of a record's revisions, newest first unless the query sorts (a 404 when the principal may not read the record). */
  async list(principal: Principal, record: RecordRef, query: ListQuery) {
    const target = await this.readable(principal, record);
    const where = and(this.of(record), REVISION_LIST.where(query));
    const [rows, total] = await Promise.all([
      this.db
        .select()
        .from(revisions)
        .where(and(where, this.after(record, query)))
        .orderBy(
          ...(query.sort?.length
            ? pageOrder(revisions.id, query)
            : [desc(revisions.number)]),
        )
        .limit(query.limit + 1)
        .offset(pageOffset(query)),
      countPage(this.db, revisions, where, query),
    ]);
    const page = toPage(rows, query, total);
    return {
      ...page,
      items: await this.views(principal, target, record, page.items),
    };
  }

  /** One revision of a record, or a 404. */
  async get(principal: Principal, record: RecordRef, number: number) {
    const target = await this.readable(principal, record);
    const [view] = await this.views(principal, target, record, [
      await this.findOne(record, number),
    ]);
    return view!;
  }

  /** What differs between two revisions of a record, from `a`'s values to `b`'s. */
  async diff(principal: Principal, record: RecordRef, a: number, b: number) {
    const target = await this.readable(principal, record);
    const [from, to] = await this.redacted(principal, target, record, [
      { snapshot: (await this.findOne(record, a)).snapshot, changes: null },
      { snapshot: (await this.findOne(record, b)).snapshot, changes: null },
    ]);
    return { from: a, to: b, changes: diff(from!.snapshot, to!.snapshot) };
  }

  /**
   * Sets the record back to a revision's fields, through the feature's own
   * update (its checks, audit entry and a new revision marked
   * `restoredFrom`); answers the record as its GET does. `unchanged` runs
   * against the locked current row before anything is written (the route's
   * If-Match).
   */
  async restore(
    principal: Principal,
    record: RecordRef,
    number: number,
    {
      ip,
      unchanged,
    }: { ip?: string; unchanged?: (current: object) => void } = {},
  ) {
    const target = await this.readable(principal, record);
    const revision = await this.findOne(record, number);
    if (!(await target.canRestore(principal, record.recordId))) {
      throw new ForbiddenException(
        `You may not change this ${record.subject}.`,
      );
    }
    return target.apply(principal, record.recordId, revision.snapshot, {
      ip,
      restoredFrom: number,
      unchanged,
    });
  }

  /** Nothing to export: revisions are the records' history, not the person's data. */
  async *rows(_user: UserPrincipal): AsyncGenerator<Record<string, unknown>[]> {
    yield* []; // a source with no rows of its own
  }

  /** An account's deletion: the revisions stay, their author becomes `anonymized`. */
  async erase(tx: Transaction, user: UserPrincipal) {
    await tx
      .update(revisions)
      .set({ changedBy: ANONYMIZED_CHANGER })
      .where(eq(revisions.changedBy, principalKey(user)));
  }

  /** When a record is gone for good: its revisions go too (in that transaction). */
  async forget(tx: Transaction, record: RecordRef) {
    await this.forgetAll(tx, record.subject, [record.recordId]);
  }

  /** `forget()` for many records of a subject (the soft-delete purge's batch). */
  async forgetAll(tx: Transaction, subject: string, recordIds: string[]) {
    await tx
      .delete(revisions)
      .where(
        and(
          eq(revisions.subject, subject),
          inArray(revisions.recordId, recordIds),
        ),
      );
  }

  /** The record's target, once the principal may read the record (else a 404: its existence stays hidden). */
  private async readable(principal: Principal, record: RecordRef) {
    const target = this.registry.get(record.subject);
    if (!(await target.canRead(principal, record.recordId))) {
      throw new NotFoundException(
        `${record.subject} ${record.recordId} not found.`,
      );
    }
    return target;
  }

  private async findOne(record: RecordRef, number: number) {
    // An integer column: a number outside it is no revision (not a database error).
    const [row] = !(number >= 1 && number <= 2_147_483_647)
      ? []
      : await this.db
          .select()
          .from(revisions)
          .where(and(this.of(record), eq(revisions.number, number)));
    if (!row) {
      throw new NotFoundException(
        `Revision ${number} of ${record.subject} ${record.recordId} not found.`,
      );
    }
    return row;
  }

  /** Snapshots and changes without what the principal may not read. */
  private async redacted(
    principal: Principal,
    target: RevisionTarget,
    record: RecordRef,
    items: RevisionItem[],
  ) {
    return target.redact
      ? target.redact(principal, record.recordId, items)
      : items;
  }

  /** Revisions as the API shows them: hidden fields left out of the snapshot and the changes, with who changed them by name. */
  private async views(
    principal: Principal,
    target: RevisionTarget,
    record: RecordRef,
    rows: Revision[],
  ): Promise<RevisionView[]> {
    const shown = await this.redacted(
      principal,
      target,
      record,
      rows.map((row) => ({ snapshot: row.snapshot, changes: row.changes })),
    );
    // Their names in one query, whatever the page's size.
    const names = await this.people.names(rows.map((row) => row.changedBy));
    return rows.map((row, index) => {
      const { snapshot, changes } = shown[index]!;
      return {
        id: row.id,
        subject: row.subject,
        recordId: row.recordId,
        number: row.number,
        snapshot,
        changes,
        restoredFrom: row.restoredFrom,
        changedBy: row.changedBy,
        changedByName: names.get(row.changedBy) ?? null,
        changedAt: row.changedAt.toISOString(),
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      };
    });
  }

  private of(record: RecordRef) {
    return and(
      eq(revisions.subject, record.subject),
      eq(revisions.recordId, record.recordId),
    );
  }

  /**
   * Newest first by default: after the cursor's revision is a lower number
   * (the list's parse checked the cursor is a UUID). A cursor of another
   * record's revision is none of this one's: no rows, as an unknown one.
   */
  private after(record: RecordRef, query: ListQuery) {
    if (!query.cursor || query.sort?.length) {
      return afterCursor(revisions.id, query);
    }
    return lt(
      revisions.number,
      sql`(select ${revisions.number} from ${revisions} where ${and(this.of(record), eq(revisions.id, query.cursor))})`,
    );
  }
}

/** What changed between two snapshots (the audit's diff; an object field, `custom`, per key). */
function diff(before: Snapshot, after: Snapshot) {
  const objects = new Set(
    [...Object.keys(before), ...Object.keys(after)].filter(
      (field) => isObject(before[field]) || isObject(after[field]),
    ),
  );
  // A field only `before` has changed too (to null).
  const all = {
    ...Object.fromEntries(Object.keys(before).map((field) => [field, null])),
    ...after,
  };
  return diffFields(before, all, { expand: objects });
}

const isObject = (value: unknown) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
