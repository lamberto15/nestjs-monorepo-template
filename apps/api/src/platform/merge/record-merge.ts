import {
  ForbiddenException,
  Inject,
  Injectable,
  UnprocessableEntityException,
} from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core';
import type { z } from 'zod';
import type { Database, Transaction } from '../../core/database/drizzle.js';
import {
  database,
  type DrizzleTransactions,
  inTransaction,
} from '../../core/database/transactions.js';
import { AccessService } from '../../iam/access/access.service.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import type { Principal } from '../../iam/auth/principal.js';
import { LegalHoldsService } from '../../iam/holds/legal-holds.service.js';
import { attachments } from '../attachments/attachments.tables.js';
import { comments } from '../comments/comments.tables.js';
import { recordSubscriptions } from '../subscriptions/subscriptions.tables.js';
import { recordTags } from '../tags/tags.tables.js';
import { duplicateRules, recordView } from '../records/record.js';
import {
  RECORD_CONTRACT,
  type RecordContract,
  type RecordPolicyContract,
  RecordPresenter,
  type RecordRow,
  type RecordServiceContract,
} from '../records/record-contract.js';
import { relationsTo } from '../records/record-relations.js';
import {
  type FindDuplicatesDto,
  MAX_DUPLICATES,
  type MergeDto,
  type MergePreview,
} from './merge.schemas.js';

type Value = string | number | boolean | null;
type Table = PgTable & Record<string, AnyPgColumn>;

const TEXT_KINDS = new Set(['string', 'text']);

/** A value as matching compares it: text without case or surrounding spaces. */
const normalized = (value: unknown) =>
  typeof value === 'string'
    ? value.trim().toLowerCase()
    : value instanceof Date
      ? value.toISOString()
      : String(value);

const filled = (value: unknown) =>
  value !== undefined && value !== null && normalized(value) !== '';

/**
 * What merging needs of a subject's records: a declared record's comes
 * from its contract (RecordMerge), a hand-written feature's from its own
 * service and policy (notes: NoteMerge).
 */
export interface MergeSource {
  subject: string;
  path: string;
  noun: string;
  /** The fields a merge may take from the duplicate (and rules match by): kind and input schema. */
  fields: Record<string, { kind: string; input: z.ZodType }>;
  /** The duplicate rules: each the fields whose values all match. */
  rules: readonly (readonly string[])[];
  table: Table;
  service: Pick<
    RecordServiceContract,
    'findOne' | 'update' | 'delete' | 'query'
  >;
  policy: Pick<RecordPolicyContract, 'update'>;
  /** A row as the API shows it: the values a merge copies to the survivor. */
  view(row: RecordRow): Record<string, unknown>;
  /** Rows as `principal` may read them (the fields hidden from them left out). */
  present(
    principal: Principal,
    rows: RecordRow[],
  ): Promise<Record<string, unknown>[]>;
  /** The merged survivor, as its routes answer it. */
  one(principal: Principal, row: RecordRow): Promise<unknown>;
}

/** The merges a feature module's merge routes call (mergeRoutes): its RecordMerge, or its own. */
export const MERGES = Symbol('MERGES');

/**
 * A subject's duplicates and their merge (the `merge` capability,
 * docs/merging.md): likely duplicates by its rules, among the records the
 * caller may read, matched only by fields they may read; a merge
 * previewed, then done in one transaction: the survivor takes the values
 * chosen from the duplicate, the duplicate's tags, comments, attachments,
 * watchers and the references to it move to the survivor, and the
 * duplicate goes to the recycle bin, each step through the feature's own
 * service (its audit entries, revisions, webhooks) plus a `<item>.merged`
 * entry naming what moved. The add-ons' rows are moved here rather than
 * through their services: each is one update of (subject, record id)
 * inside the merge's transaction, a change none of their services offers.
 */
@Injectable()
export abstract class Merges {
  protected abstract readonly s: MergeSource;

  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly holds: LegalHoldsService,
  ) {}

  private get subject() {
    return this.s.subject;
  }

  private get table() {
    return this.s.table;
  }

  private kind(field: string) {
    return (this.s.fields[field] as { kind: string }).kind;
  }

  /** A value a rule can match by: given, and one the field takes (else no query could compare it). */
  private usable(field: string, value: unknown) {
    const f = this.s.fields[field] as { input: z.ZodType };
    return filled(value) && f.input.safeParse(value).success;
  }

  /** One rule's condition: each of its fields equal to the value. */
  private matches(rule: readonly string[], values: Record<string, Value>) {
    return and(
      ...rule.map((field) => {
        const column = this.table[field]!;
        return TEXT_KINDS.has(this.kind(field))
          ? eq(sql`lower(trim(${column}))`, normalized(values[field]))
          : eq(column, values[field]);
      }),
    );
  }

  /**
   * The live records `principal` may read that match `values` by a rule,
   * newest first: each with the rules it matched on fields the principal
   * may read on it (a match by a hidden field is no match: it would tell
   * the hidden value).
   */
  async find(principal: Principal, { values, excludeId }: FindDuplicatesDto) {
    const rules = this.s.rules.filter((rule) =>
      rule.every((field) => this.usable(field, values[field])),
    );
    if (rules.length === 0) return { items: [] };
    const table = this.table;
    const visible = await this.access.sqlFilter(
      principal,
      this.subject,
      'read',
    );
    const rows = (await this.s.service.query((db) =>
      db
        .select()
        .from(table)
        .where(
          and(
            visible,
            or(...rules.map((rule) => this.matches(rule, values))),
            excludeId ? ne(table.id!, excludeId) : undefined,
          ),
        )
        .orderBy(desc(table.id!))
        .limit(MAX_DUPLICATES),
    )) as RecordRow[];
    const shown = await this.s.present(principal, rows);
    const items = rows.flatMap((row, i) => {
      const record = shown[i]!;
      const matched = rules.filter((rule) =>
        rule.every(
          (field) =>
            field in record &&
            normalized(row[field]) === normalized(values[field]),
        ),
      );
      return matched.length ? [{ id: row.id, matched, record }] : [];
    });
    return { items };
  }

  /** The duplicates of a record, by its values the principal may read. */
  async duplicatesOf(principal: Principal, id: string) {
    const row = await this.s.service.findOne(id, undefined, {
      visibleTo: principal,
    });
    const [shown] = await this.s.present(principal, [row]);
    const values = Object.fromEntries(
      this.s.rules
        .flat()
        .filter((field) => field in shown!)
        .map((field) => [field, row[field] as Value]),
    );
    return this.find(principal, { values, excludeId: id });
  }

  /** What merging `dto.duplicateId` into record `id` would do, checked as the merge checks it. */
  async preview(
    principal: Principal,
    id: string,
    dto: MergeDto,
  ): Promise<MergePreview> {
    const { preview } = await this.plan(
      principal,
      id,
      dto,
      database(this.txHost),
    );
    return preview;
  }

  /**
   * Merges `dto.duplicateId` into record `id`, in one transaction: all of
   * it, or (any check or write refused) none of it. Answers the survivor.
   */
  merge(principal: Principal, id: string, dto: MergeDto, ip?: string) {
    return inTransaction(this.txHost, async (tx) => {
      // Both rows locked, in id order (two merges of the same pair can't deadlock).
      await tx
        .select({ id: this.table.id! })
        .from(this.table)
        .where(inArray(this.table.id!, [id, dto.duplicateId]))
        .orderBy(asc(this.table.id!))
        .for('update');
      const { survivor, duplicate, changes } = await this.plan(
        principal,
        id,
        dto,
        tx,
      );
      const moved = await this.move(tx, duplicate.id, survivor.id);
      // To the recycle bin first: a unique value it holds is free for the survivor.
      await this.s.service.delete(principal, duplicate, ip);
      const merged =
        Object.keys(changes).length > 0
          ? await this.s.service.update(principal, survivor, changes, ip)
          : survivor;
      const key = this.s.subject[0]!.toLowerCase() + this.s.subject.slice(1);
      await this.audit.record(
        principal,
        {
          action: `${key}.merged`,
          targetType: key,
          targetId: survivor.id,
          details: {
            duplicateId: duplicate.id,
            fields: Object.keys(changes),
            ...moved,
          },
          ip,
        },
        tx,
      );
      return this.s.one(principal, merged);
    });
  }

  /**
   * The checks, and what the merge would change: both records readable,
   * the survivor changeable and the duplicate deletable by the principal,
   * the duplicate under no legal hold, each chosen field one they may read
   * on both and change on the survivor, every record referring to the
   * duplicate (in the recycle bin too) one they may change, and no reference of the survivor's to
   * the duplicate left.
   */
  private async plan(
    principal: Principal,
    id: string,
    dto: MergeDto,
    db: Database | Transaction,
  ) {
    if (id === dto.duplicateId) {
      throw new UnprocessableEntityException({
        code: 'merge_same_record',
        message: `A ${this.s.noun} can't be merged into itself.`,
      });
    }
    const survivor = await this.s.service.findOne(id, db, {
      visibleTo: principal,
    });
    const duplicate = await this.s.service.findOne(dto.duplicateId, db, {
      visibleTo: principal,
    });
    if (
      !(await this.s.policy.update(principal, survivor)) ||
      !(await this.access.can(principal, 'delete', this.subject, duplicate))
    ) {
      throw new ForbiddenException(
        `You may not merge these ${this.s.path.replace(/-/g, ' ')}: it takes changing the survivor and deleting the duplicate.`,
      );
    }
    await this.holds.assertNotHeld(this.subject, [duplicate.id], db);

    const [shownSurvivor, shownDuplicate] = await this.s.present(principal, [
      survivor,
      duplicate,
    ]);
    const readable = Object.keys(this.s.fields).filter(
      (field) => field in shownSurvivor! && field in shownDuplicate!,
    );
    const unwritable = new Set(
      await this.access.forbiddenFields(
        principal,
        'update',
        this.subject,
        Object.fromEntries(readable.map((field) => [field, true])),
        survivor,
      ),
    );
    const choosable = readable.filter((field) => !unwritable.has(field));
    const refused = Object.keys(dto.fields).filter(
      (field) =>
        dto.fields[field] === 'duplicate' && !choosable.includes(field),
    );
    if (refused.length) {
      throw new ForbiddenException({
        code: 'field_forbidden',
        message: `You may not choose: ${refused.join(', ')}.`,
        fields: refused,
      });
    }
    const duplicateView = this.s.view(duplicate);
    const changes = Object.fromEntries(
      choosable
        .filter((field) => dto.fields[field] === 'duplicate')
        .map((field) => [field, duplicateView[field]]),
    );
    for (const relation of relationsTo(this.subject).filter(
      (relation) => relation.from.subject === this.subject,
    )) {
      const value =
        relation.field in changes
          ? changes[relation.field]
          : survivor[relation.field];
      if (relation.target() === this.subject && value === duplicate.id) {
        throw new UnprocessableEntityException({
          code: 'merge_self_reference',
          message: `${relation.field}: the survivor would refer to itself; choose another value first.`,
          field: relation.field,
        });
      }
    }

    const references = await this.references(principal, db, duplicate.id);
    const tally = async (table: Table) => {
      const [row] = await db
        .select({ n: count() })
        .from(table)
        .where(
          and(
            eq(table.subject!, this.subject),
            eq(table.recordId!, duplicate.id),
          ),
        );
      return row?.n ?? 0;
    };
    const preview: MergePreview = {
      survivor: shownSurvivor!,
      duplicate: shownDuplicate!,
      fields: choosable.map((name) => ({
        name,
        survivor: shownSurvivor![name] ?? null,
        duplicate: shownDuplicate![name] ?? null,
        differs:
          JSON.stringify(shownSurvivor![name] ?? null) !==
          JSON.stringify(shownDuplicate![name] ?? null),
        keep: dto.fields[name] === 'duplicate' ? 'duplicate' : 'survivor',
      })),
      result: {
        ...shownSurvivor,
        ...Object.fromEntries(
          Object.keys(changes).map((field) => [field, shownDuplicate![field]]),
        ),
      },
      moves: {
        tags: await tally(recordTags as unknown as Table),
        comments: await tally(comments as unknown as Table),
        attachments: await tally(attachments as unknown as Table),
        watchers: await tally(recordSubscriptions as unknown as Table),
        references: references.map(({ subject, field, count }) => ({
          subject,
          field,
          count,
        })),
      },
    };
    return { survivor, duplicate, changes, preview };
  }

  /**
   * The relations whose records refer to the duplicate, with how many do:
   * refused (403) when any of them, live or in the recycle bin, is one the
   * principal may not change. Those in the bin are repointed too, so a
   * restore brings them back pointing at the survivor: the same check, as
   * the bin's rows (an update permission's conditions on deleted records).
   */
  private async references(
    principal: Principal,
    db: Database | Transaction,
    duplicateId: string,
  ) {
    const found = [];
    for (const relation of relationsTo(this.subject)) {
      const table = relation.table;
      const soft = relation.from.softDelete;
      let total = 0;
      for (const deleted of soft ? [false, true] : [false]) {
        const state = soft
          ? deleted
            ? isNotNull(table.deletedAt!)
            : isNull(table.deletedAt!)
          : undefined;
        const referring = (where?: SQL) =>
          db
            .select({ n: count() })
            .from(table)
            .where(and(eq(relation.column, duplicateId), state, where))
            .then(([row]) => row?.n ?? 0);
        const n = await referring();
        if (n === 0) continue;
        const changeable = await referring(
          await this.access.sqlFilter(
            principal,
            relation.from.subject,
            'update',
            { deleted },
          ),
        );
        if (changeable < n) {
          throw new ForbiddenException({
            code: 'merge_references_forbidden',
            message: `Some ${relation.from.path.replace(/-/g, ' ')} refer to the duplicate (${relation.field}) that you may not change.`,
            subject: relation.from.subject,
            field: relation.field,
          });
        }
        total += n;
      }
      if (total === 0) continue;
      found.push({
        relation,
        subject: relation.from.subject,
        field: relation.field,
        count: total,
      });
    }
    return found;
  }

  /** The duplicate's add-ons and the references to it, moved to the survivor: their ids, for the audit entry. */
  private async move(tx: Transaction, from: string, to: string) {
    const subject = this.subject;
    const references = [];
    for (const relation of relationsTo(subject)) {
      const rows = await tx
        .update(relation.table)
        .set({ [relation.field]: to })
        .where(eq(relation.column, from))
        .returning({ id: relation.table.id! });
      if (rows.length) {
        references.push({
          subject: relation.from.subject,
          field: relation.field,
          ids: rows.map((row) => row.id as string),
        });
      }
    }
    const movedComments = await tx
      .update(comments)
      .set({ recordId: to })
      .where(and(eq(comments.subject, subject), eq(comments.recordId, from)))
      .returning({ id: comments.id });
    const movedAttachments = await tx
      .update(attachments)
      .set({ recordId: to })
      .where(
        and(eq(attachments.subject, subject), eq(attachments.recordId, from)),
      )
      .returning({ id: attachments.id });
    // Tags and watchers: the survivor keeps its own, and gains the duplicate's.
    const tags = await tx
      .delete(recordTags)
      .where(
        and(eq(recordTags.subject, subject), eq(recordTags.recordId, from)),
      )
      .returning();
    if (tags.length) {
      await tx
        .insert(recordTags)
        .values(tags.map((tag) => ({ ...tag, recordId: to })))
        .onConflictDoNothing();
    }
    const watchers = await tx
      .delete(recordSubscriptions)
      .where(
        and(
          eq(recordSubscriptions.subject, subject),
          eq(recordSubscriptions.recordId, from),
        ),
      )
      .returning();
    if (watchers.length) {
      await tx
        .insert(recordSubscriptions)
        .values(
          watchers.map(({ id: _id, ...watcher }) => ({
            ...watcher,
            recordId: to,
          })),
        )
        .onConflictDoNothing();
    }
    return {
      comments: movedComments.map((row) => row.id),
      attachments: movedAttachments.map((row) => row.id),
      tags: tags.map((tag) => tag.tagId),
      watchers: watchers.length,
      references,
    };
  }
}

/** A declared record's merges (recordParts, with `merge`): from its contract. */
@Injectable()
export class RecordMerge extends Merges {
  protected readonly s: MergeSource;

  constructor(
    @Inject(RECORD_CONTRACT) c: RecordContract,
    presenter: RecordPresenter,
    txHost: TransactionHost<DrizzleTransactions>,
    access: AccessService,
    audit: AuditService,
    holds: LegalHoldsService,
  ) {
    super(txHost, access, audit, holds);
    const { declaration } = c;
    this.s = {
      subject: declaration.subject,
      path: declaration.path,
      noun: declaration.noun,
      fields: declaration.fields as MergeSource['fields'],
      rules: duplicateRules(declaration),
      table: c.table as unknown as Table,
      service: c.service,
      policy: c.policy,
      view: (row) => recordView(declaration, row) as Record<string, unknown>,
      present: (principal, rows) => presenter.many(principal, rows),
      one: (principal, row) => presenter.one(principal, row),
    };
  }
}
