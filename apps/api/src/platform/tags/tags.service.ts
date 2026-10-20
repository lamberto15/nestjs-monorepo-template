import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import {
  and,
  asc,
  count,
  eq,
  getTableColumns,
  inArray,
  notInArray,
  sql,
} from 'drizzle-orm';
import type { Transaction } from '../../core/database/drizzle.js';
import { RecordPurgeRegistry } from '../../iam/resources/record-purge.registry.js';
import {
  database,
  type DrizzleTransactions,
  inTransaction,
} from '../../core/database/transactions.js';
import type { ListQuery } from '../../core/http/list-query.js';
import {
  afterCursor,
  countPage,
  pageOffset,
  pageOrder,
  toPage,
} from '../../core/http/pagination.js';
import { uniqueToConflict } from '../../iam/access/api-clients.service.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import type { Principal } from '../../iam/auth/principal.js';
import { defineResource } from '../../iam/resources/resource.js';
import type { RecordRef } from '../subscriptions/subscriptions.service.js';
import { TAG_LIST } from './tag.list.js';
import type { CreateTagDto, TagRef, UpdateTagDto } from './tag.schemas.js';
import { TagsRegistry } from './tags.registry.js';
import { recordTags, tags } from './tags.tables.js';

type Tag = typeof tags.$inferSelect;

/** Tags are audited as `tag.created`, `tag.updated` (what changed), `tag.deleted`. */
export const TAG = defineResource({ subject: 'Tag', audit: {} });

const view = (tag: Tag, usageCount: number) => ({
  ...tag,
  usageCount,
  createdAt: tag.createdAt.toISOString(),
  updatedAt: tag.updatedAt.toISOString(),
});

const ref = ({ id, name, color }: Pick<Tag, 'id' | 'name' | 'color'>) => ({
  id,
  name,
  color,
});

/**
 * Tags (labels) on any feature's records. Administrators
 * (`Access.manageTags`) define them per subject; a feature registers its
 * records (`TagsRegistry`, a `TagTarget`: who may change a record's tags)
 * and sets a record's tags with `setTags`. Lists show them with `tagsOf`
 * (one query per page) and filter by them with `tagFilter` (tag.list.ts).
 *
 * Each write is one transaction with its audit entry.
 */
@Injectable()
export class TagsService {
  /** The current transaction, or the database outside one (core/database/transactions.ts). */
  private get db() {
    return database(this.txHost);
  }

  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly registry: TagsRegistry,
    private readonly audit: AuditService,
    purges: RecordPurgeRegistry,
  ) {
    // A record purged from its recycle bin: its tags go with it.
    purges.register({
      name: 'tags',
      forget: (tx, subject, ids) => this.forgetAll(tx, subject, ids),
    });
  }

  /** A page of tags, newest first unless the query sorts. */
  async list(query: ListQuery) {
    const where = TAG_LIST.where(query);
    const [rows, total] = await Promise.all([
      this.db
        // With the sort values the cursor needs (lower(name)); pick() drops them.
        .select({ ...getTableColumns(tags), ...TAG_LIST.sortSelect(query) })
        .from(tags)
        .where(and(where, afterCursor(tags.id, query)))
        .orderBy(...pageOrder(tags.id, query))
        .limit(query.limit + 1)
        .offset(pageOffset(query)),
      countPage(this.db, tags, where, query),
    ]);
    const page = toPage(rows, query, total);
    // How many records carry each tag: one grouped query per page.
    const usage = await this.usageOf(page.items.map((row) => row.id));
    return {
      ...page,
      items: page.items.map((row) => view(row, usage.get(row.id) ?? 0)),
    };
  }

  /** Records carrying each tag (`record_tags`), one query for all `ids`. */
  private async usageOf(ids: string[]): Promise<Map<string, number>> {
    if (ids.length === 0) {
      return new Map();
    }
    const rows = await this.db
      .select({ tagId: recordTags.tagId, count: count() })
      .from(recordTags)
      .where(inArray(recordTags.tagId, ids))
      .groupBy(recordTags.tagId);
    return new Map(rows.map((row) => [row.tagId, row.count]));
  }

  async findOne(id: string): Promise<Tag> {
    const [tag] = await this.db.select().from(tags).where(eq(tags.id, id));
    if (!tag) {
      throw new NotFoundException(`Tag ${id} not found.`);
    }
    return tag;
  }

  /** A new tag of a subject that takes tags; a 409 when its name is taken (whatever the case). */
  async create(principal: Principal, dto: CreateTagDto, ip?: string) {
    if (!this.registry.find(dto.subject)) {
      throw new BadRequestException({
        code: 'validation_failed',
        message: 'The request is invalid.',
        errors: [
          {
            path: 'subject',
            message: `"${dto.subject}" takes no tags: one of ${this.registry.subjects().join(', ')}`,
          },
        ],
      });
    }
    const row = await inTransaction(this.txHost, async (tx) => {
      const [created] = await tx
        .insert(tags)
        .values({
          subject: dto.subject,
          name: dto.name,
          color: dto.color ?? null,
          description: dto.description || null,
        })
        .returning();
      await this.audit.recordChange(
        principal,
        TAG,
        { action: 'created', id: created!.id, after: created! },
        tx,
        ip,
      );
      return created!;
    }).catch((error: unknown) => {
      throw uniqueToConflict(error, this.taken(dto.subject, dto.name));
    });
    return view(row, 0);
  }

  /** Renames, recolours or redescribes a tag: only what is sent changes. */
  async update(
    principal: Principal,
    id: string,
    dto: UpdateTagDto,
    ip?: string,
  ) {
    const tag = await this.findOne(id);
    const values = Object.fromEntries(
      Object.entries(dto).filter(([, value]) => value !== undefined),
    ) as UpdateTagDto;
    if (values.description === '') {
      values.description = null;
    }
    if (Object.keys(values).length === 0) {
      return view(tag, (await this.usageOf([id])).get(id) ?? 0);
    }
    const row = await inTransaction(this.txHost, async (tx) => {
      const [updated] = await tx
        .update(tags)
        .set(values)
        .where(eq(tags.id, id))
        .returning();
      await this.audit.recordChange(
        principal,
        TAG,
        { action: 'updated', id, before: tag, after: updated! },
        tx,
        ip,
      );
      return updated!;
    }).catch((error: unknown) => {
      throw uniqueToConflict(
        error,
        this.taken(tag.subject, values.name ?? tag.name),
      );
    });
    return view(row, (await this.usageOf([id])).get(id) ?? 0);
  }

  /** Deletes a tag: every record loses it (the links cascade). */
  async remove(principal: Principal, id: string, ip?: string) {
    const tag = await this.findOne(id);
    await inTransaction(this.txHost, async (tx) => {
      await tx.delete(tags).where(eq(tags.id, id));
      await this.audit.recordChange(
        principal,
        TAG,
        { action: 'deleted', id, before: tag },
        tx,
        ip,
      );
    });
  }

  /**
   * Replaces a record's tags with `tagIds`, in one transaction with one
   * audit entry (`tags.changed`, from → to): a 403 when the principal may
   * not tag the record (the feature's `canTag`), a 400 naming each id that
   * is not a tag of the record's subject. Returns the record's tags.
   */
  async setTags(
    principal: Principal,
    record: RecordRef,
    tagIds: readonly string[],
    ip?: string,
  ): Promise<TagRef[]> {
    const target = this.registry.find(record.subject);
    if (!target) {
      throw new Error(
        `"${record.subject}" takes no tags: register a TagTarget for it.`,
      );
    }
    if (!(await target.canTag(principal, record.recordId))) {
      throw new ForbiddenException(
        `You may not change the tags of ${record.subject} ${record.recordId}.`,
      );
    }
    const wanted = [...new Set(tagIds)];
    await inTransaction(this.txHost, async (tx) => {
      // One change of a record's set at a time: two at once would merge
      // their sets and each audit a `to` that isn't.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`${record.subject}:${record.recordId}`}))`,
      );
      // Shared locks: a tag deleted meanwhile would fail the insert (a 500, not the 400).
      const found = wanted.length
        ? await tx
            .select({ id: tags.id })
            .from(tags)
            .where(
              and(eq(tags.subject, record.subject), inArray(tags.id, wanted)),
            )
            .for('share')
        : [];
      const known = new Set(found.map((row) => row.id));
      const unknown = tagIds
        .map((id, index) => ({ id, index }))
        .filter(({ id }) => !known.has(id));
      if (unknown.length) {
        throw new BadRequestException({
          code: 'validation_failed',
          message: 'The request is invalid.',
          errors: unknown.map(({ id, index }) => ({
            path: `tagIds.${index}`,
            message: `No ${record.subject} tag ${id}`,
          })),
        });
      }
      const before = (
        await tx
          .select({ tagId: recordTags.tagId })
          .from(recordTags)
          .where(this.of(record))
      ).map((row) => row.tagId);
      const added = wanted.filter((id) => !before.includes(id));
      const removed = before.filter((id) => !wanted.includes(id));
      if (!added.length && !removed.length) {
        return;
      }
      if (removed.length) {
        await tx
          .delete(recordTags)
          .where(
            and(
              this.of(record),
              wanted.length ? notInArray(recordTags.tagId, wanted) : undefined,
            ),
          );
      }
      if (added.length) {
        await tx
          .insert(recordTags)
          .values(added.map((tagId) => ({ ...record, tagId })))
          .onConflictDoNothing();
      }
      await this.audit.record(
        principal,
        {
          action: 'tags.changed',
          targetType:
            record.subject.charAt(0).toLowerCase() + record.subject.slice(1),
          targetId: record.recordId,
          details: {
            subject: record.subject,
            from: before,
            to: wanted,
            added,
            removed,
          },
          ip,
        },
        tx,
      );
    });
    return (await this.tagsOf(record.subject, [record.recordId])).get(
      record.recordId,
    )!;
  }

  /**
   * The tags of records of a subject, by record id (every id given has an
   * entry, [] when untagged), by name: one query for a whole page.
   */
  async tagsOf(
    subject: string,
    recordIds: readonly string[],
  ): Promise<Map<string, TagRef[]>> {
    const result = new Map<string, TagRef[]>(
      recordIds.map((id) => [id, []] as [string, TagRef[]]),
    );
    if (!recordIds.length) {
      return result;
    }
    const rows = await this.db
      .select({
        recordId: recordTags.recordId,
        id: tags.id,
        name: tags.name,
        color: tags.color,
      })
      .from(recordTags)
      .innerJoin(tags, eq(tags.id, recordTags.tagId))
      .where(
        and(
          eq(recordTags.subject, subject),
          inArray(recordTags.recordId, [...new Set(recordIds)]),
        ),
      )
      .orderBy(asc(sql`lower(${tags.name})`), asc(tags.id));
    for (const row of rows) {
      result.get(row.recordId)?.push(ref(row));
    }
    return result;
  }

  /** When a record is gone for good: its tags go with it. */
  async forget(tx: Transaction, record: RecordRef) {
    await this.forgetAll(tx, record.subject, [record.recordId]);
  }

  /** `forget()` for many records of a subject (the soft-delete purge's batch). */
  async forgetAll(tx: Transaction, subject: string, recordIds: string[]) {
    await tx
      .delete(recordTags)
      .where(
        and(
          eq(recordTags.subject, subject),
          inArray(recordTags.recordId, recordIds),
        ),
      );
  }

  private of(record: RecordRef) {
    return and(
      eq(recordTags.subject, record.subject),
      eq(recordTags.recordId, record.recordId),
    );
  }

  private taken(subject: string, name: string) {
    return `A ${subject} tag named "${name}" exists already.`;
  }
}
