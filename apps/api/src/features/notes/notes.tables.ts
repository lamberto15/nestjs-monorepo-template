import { type SQL, sql } from 'drizzle-orm';
import {
  index,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { searchVector } from '../../core/database/search.js';
import {
  at,
  softDeletable,
  timestamps,
  uuidPk,
} from '../../core/database/columns.js';
import { orgUnits } from '../../iam/iam.tables.js';
import type { NoteStatus } from './note.schemas.js';

/** Notes: the example resource. `ownerId` is the principal that created it, `user:<id>` or `client:<id>`. */
export const notes = pgTable(
  'notes',
  {
    id: uuidPk(),
    /** The number people quote, `NOTE-2026-00042` (platform/sequences): set on create. */
    number: text('number'),
    ownerId: text('owner_id').notNull(),
    /** The author's org unit (users in a unit): what `inMyUnits` reads. */
    orgUnitId: uuid('org_unit_id').references(() => orgUnits.id, {
      onDelete: 'set null',
    }),
    title: text('title').notNull(),
    body: text('body').notNull(),
    status: text('status').$type<NoteStatus>().notNull(),
    ...timestamps(),
    publishedAt: at('published_at'),
    /**
     * Custom field values by key (platform/custom-fields): the fields
     * administrators add at runtime, checked against their definitions on
     * every write. GIN-indexed for `?` and `@>` (has a value, equals, holds).
     */
    custom: jsonb('custom')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    /** The recycle bin: set when deleted, cleared on restore (NOTE.softDelete). */
    ...softDeletable(),
    /** Full-text search over the title and the text (core/database/search.ts): `?q=`, GET /search. */
    search: searchVector(
      'search',
      (): SQL => sql`${notes.title} || ' ' || ${notes.body}`,
    ),
  },
  (table) => [
    uniqueIndex('notes_number_idx').on(table.number),
    index('notes_owner_id_idx').on(table.ownerId),
    // The purge job finds old deleted rows by it.
    index('notes_deleted_at_idx').on(table.deletedAt),
    index('notes_custom_idx').using('gin', table.custom),
    index('notes_search_idx').using('gin', table.search),
  ],
);
