import { sql } from 'drizzle-orm';
import {
  index,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { at, timestamps, uuidPk } from '../../core/database/columns.js';

/**
 * Tags (labels) administrators define per subject (`Note`): a name unique
 * per subject whatever its case, a colour, a description.
 */
export const tags = pgTable(
  'tags',
  {
    id: uuidPk(),
    /** The records' permission subject: `Note`. */
    subject: text('subject').notNull(),
    name: text('name').notNull(),
    /** `#rrggbb`. */
    color: text('color'),
    description: text('description'),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('tags_subject_name_idx').on(
      table.subject,
      sql`lower(${table.name})`,
    ),
  ],
);

/**
 * Which record carries which tag: a link row, added and removed, never
 * edited. Deleting a tag removes its links (cascade).
 */
export const recordTags = pgTable(
  'record_tags',
  {
    tagId: uuid('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
    /** The record's permission subject: `Note` (the tag's own). */
    subject: text('subject').notNull(),
    recordId: uuid('record_id').notNull(),
    createdAt: at('created_at').notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tagId, table.recordId] }),
    index('record_tags_record_idx').on(table.subject, table.recordId),
  ],
);
