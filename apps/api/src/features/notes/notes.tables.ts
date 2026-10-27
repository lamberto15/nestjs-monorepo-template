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
import { utcMilliseconds } from '../../core/database/utc-milliseconds.js';
import {
  at,
  softDeletable,
  timestamps,
  uuidPk,
} from '../../core/database/columns.js';
import {
  tenantColumn,
  tenantReference,
  tenantTable,
} from '../../core/tenancy/tenant-scope.js';
import { organizationalUnits } from '../../iam/iam.tables.js';
import type { NoteStatus } from './note.schemas.js';

/** Notes: the example resource. `ownerId` is the principal that created it, `user:<id>` or `client:<id>`. */
export const notes = pgTable(
  'notes',
  {
    id: uuidPk(),
    /** The tenant the note belongs to (docs/tenancy.md): every feature table has one. */
    tenantId: tenantColumn(),
    /** The number people quote, `NOTE-2026-00042` (platform/sequences): set on create. */
    number: text('number'),
    ownerId: text('owner_id').notNull(),
    /** The author's organizational unit (when they are in exactly one): what the unit conditions read. */
    unitId: uuid('unit_id'),
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
    // Uniques are per tenant: each numbers its own notes.
    uniqueIndex('notes_number_idx').on(table.tenantId, table.number),
    // The dashboard's week range and the notes list's default ordering.
    index('notes_tenant_created_at_idx')
      .on(table.tenantId, table.createdAt.desc(), table.id.desc())
      .where(sql`deleted_at is null`),
    index('notes_tenant_updated_at_idx')
      .on(table.tenantId, table.updatedAt.desc(), table.id.desc())
      .where(sql`deleted_at is null`),
    // The API's list sort truncates timestamps to JavaScript's millisecond precision.
    index('notes_tenant_created_ms_idx')
      .on(
        table.tenantId,
        sql`${utcMilliseconds(table.createdAt)} desc nulls first`,
        table.id.desc(),
      )
      .where(sql`deleted_at is null`),
    index('notes_tenant_updated_ms_idx')
      .on(
        table.tenantId,
        sql`${utcMilliseconds(table.updatedAt)} desc nulls first`,
        table.id.desc(),
      )
      .where(sql`deleted_at is null`),
    index('notes_owner_id_idx').on(table.ownerId),
    // The purge job finds old deleted rows by it.
    index('notes_deleted_at_idx').on(table.deletedAt),
    index('notes_custom_idx').using('gin', table.custom),
    index('notes_search_idx').using('gin', table.search),
    // The policies and the unique (tenant_id, id) other tables' keys point at.
    ...tenantTable('notes', table),
    // A key within the tenant: (tenant_id, unit_id), never another tenant's
    // unit. A unit with notes can't be deleted (409 `unit_not_empty`).
    tenantReference(
      'notes_unit_fk',
      [table.tenantId, table.unitId],
      [organizationalUnits.tenantId, organizationalUnits.id],
      'restrict',
    ),
  ],
).enableRLS();
