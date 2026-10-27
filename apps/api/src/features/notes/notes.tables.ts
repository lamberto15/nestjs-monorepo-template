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
import { teams } from '../../iam/iam.tables.js';
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
    /** The author's team (users in a team): what `inMyTeams` reads. */
    teamId: uuid('team_id'),
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
    // The `mine` read condition and ?ownerId= (one BitmapOr arm), and the
    // account export's owner pages in id order (NoteTransfer.rows).
    index('notes_owner_id_id_idx').on(table.ownerId, table.id.desc()),
    // The `inMyTeams` read condition and ?teamId= (the other BitmapOr arm),
    // and notes_team_fk's ON DELETE SET NULL lookup: not partial, the key
    // also reaches deleted notes.
    index('notes_tenant_team_id_idx').on(table.tenantId, table.teamId),
    // ?status= with the default order, and ?sort=status.
    index('notes_tenant_status_id_idx')
      .on(table.tenantId, table.status, table.id.desc())
      .where(sql`deleted_at is null`),
    // ?sort=title (asc nulls last, then id desc, as sortOrder() spells it).
    index('notes_tenant_title_id_idx')
      .on(table.tenantId, table.title.asc().nullsLast(), table.id.desc())
      .where(sql`deleted_at is null`),
    // ?sort=-publishedAt: the list sorts by the UTC millisecond expression.
    index('notes_tenant_published_ms_idx')
      .on(
        table.tenantId,
        sql`${utcMilliseconds(table.publishedAt)} desc nulls first`,
        table.id.desc(),
      )
      .where(sql`deleted_at is null`),
    // The purge job finds old deleted rows by it: live rows (NULL) left out.
    index('notes_deleted_at_idx')
      .on(table.deletedAt)
      .where(sql`deleted_at is not null`),
    index('notes_custom_idx').using('gin', table.custom),
    index('notes_search_idx').using('gin', table.search),
    // The policies and the unique (tenant_id, id) other tables' keys point at.
    ...tenantTable('notes', table),
    // A key within the tenant: (tenant_id, team_id), never another tenant's team.
    tenantReference(
      'notes_team_fk',
      [table.tenantId, table.teamId],
      [teams.tenantId, teams.id],
      'set null',
    ),
  ],
).enableRLS();
