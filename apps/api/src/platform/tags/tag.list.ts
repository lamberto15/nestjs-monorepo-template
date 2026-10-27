import { type AnyColumn, and, eq, exists, inArray, sql } from 'drizzle-orm';
import { QueryBuilder } from 'drizzle-orm/pg-core';
import type { FilterField } from '../../core/http/list-query.js';
import { listQuery } from '../../core/http/list-query.js';
import { tagSchema } from './tag.schemas.js';
import { recordTags, tags } from './tags.tables.js';

/** What GET /tags can be filtered and sorted by. */
export const TAG_LIST = listQuery(
  {
    subject: { column: tags.subject, type: 'string', ops: ['eq', 'in'] },
    name: {
      column: tags.name,
      type: 'string',
      ops: ['eq', 'contains', 'startsWith'],
      // A name is unique whatever its case: so are its filter and its order.
      sortable: true,
      sort: sql`lower(${tags.name})`,
      conditions: {
        eq: (value) => sql`lower(${tags.name}) = lower(${value as string})`,
      },
    },
    createdAt: {
      column: tags.createdAt,
      type: 'datetime',
      ops: ['gt', 'gte', 'lt', 'lte', 'between'],
      sortable: true,
    },
    updatedAt: {
      column: tags.updatedAt,
      type: 'datetime',
      ops: ['gt', 'gte', 'lt', 'lte', 'between'],
      sortable: true,
    },
  },
  { select: Object.keys(tagSchema.shape) },
);

/** The records of `subject` (by their id column) carrying any of `tagIds`. */
const tagged = (subject: string, id: AnyColumn, tagIds: string[]) =>
  exists(
    new QueryBuilder()
      .select({ one: sql`1` })
      .from(recordTags)
      .where(
        and(
          eq(recordTags.subject, subject),
          eq(recordTags.recordId, id),
          inArray(recordTags.tagId, tagIds),
        ),
      ),
  );

/**
 * The list field of a feature whose records carry tags: `?tag=<id>` (the
 * records carrying it) and `?tag.in=<id>,<id>` (carrying any of them), an
 * EXISTS on record_tags (indexed by record). Spread it into the list
 * declaration, with the records' id column:
 *
 * ```ts
 * export const NOTE_LIST = listQuery({ ...tagFilter('Note', notes.id), … });
 * ```
 */
export const tagFilter = (
  subject: string,
  id: AnyColumn,
): Record<'tag', FilterField> => ({
  tag: {
    column: id,
    type: 'uuid',
    ops: ['eq', 'in'],
    // The values are tag ids (GET /tags).
    ref: 'tag',
    conditions: {
      eq: (value) => tagged(subject, id, [value as string]),
      in: (value) => tagged(subject, id, value as string[]),
    },
  },
});
