import { sql } from 'drizzle-orm';
import { index, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import {
  softDeletable,
  timestamps,
  uuidPk,
} from '../../core/database/columns.js';
import { searchVector } from '../../core/database/search.js';
import {
  tenantColumn,
  tenantReference,
  tenantTable,
} from '../../core/tenancy/tenant-scope.js';
import { teams } from '../../iam/iam.tables.js';
import { columnName, type Fields } from '../fields/field.js';
import {
  type FieldColumns,
  fieldColumns,
  fieldExtras,
  fieldValues,
  fieldView,
  type FieldView,
  searchableFields,
} from '../fields/fields.js';
import type { RecordRouteSpec } from './record-routes.js';

/**
 * A feature's records, declared once (`features/<x>/<x>.record.ts`): what
 * the routes call them, their table, their fields (platform/fields) and the
 * capabilities they take. The table, schemas, list, the capabilities'
 * targets and routes, and the service's steps are derived from it
 * (recordTable, record.schemas.ts, record-list.ts, record-parts.ts): adding
 * a field or a capability is a line here, then `pnpm feature:sync` and
 * `pnpm db:generate`. No Nest here: the tables import it.
 */

/** What a record can take, each a platform module (docs/adding-a-feature.md). */
export const CAPABILITIES = [
  'tags',
  'comments',
  'attachments',
  'revisions',
  'pdf',
  'bulk',
  'watch',
  'search',
  'transfer',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

export interface RecordDeclaration<
  F extends Fields = Fields,
  C extends readonly Capability[] = readonly Capability[],
> extends RecordRouteSpec {
  /** The SQL table: `invoices`. */
  table: string;
  /** Deleted records go to a recycle bin (`deletedAt`), restorable until purged. */
  softDelete: boolean;
  /** Records carry their creator's team (`teamId`, the `inMyTeams` condition). */
  team: boolean;
  fields: F;
  capabilities: C;
}

/** A record's declaration, typed: `export const INVOICE = defineRecord({ … })`. */
export function defineRecord<
  const F extends Fields,
  const C extends readonly Capability[],
  const D extends RecordDeclaration<F, C>,
>(declaration: D & { fields: F; capabilities: C }): D {
  for (const capability of declaration.capabilities) {
    if (!CAPABILITIES.includes(capability)) {
      throw new Error(`${declaration.subject}: no capability "${capability}".`);
    }
  }
  if (
    declaration.capabilities.includes('search') &&
    searchableFields(declaration.fields).length === 0
  ) {
    throw new Error(
      `${declaration.subject} takes search: mark the fields it searches with .searchable().`,
    );
  }
  if (
    declaration.capabilities.includes('pdf') &&
    !declaration.capabilities.includes('attachments')
  ) {
    throw new Error(
      `${declaration.subject} takes pdf: add attachments too (a PDF is one of the record's attachments).`,
    );
  }
  return declaration;
}

/** `Invoice` → `invoice`: notification types, i18n keys, document names. */
export const recordKey = (declaration: RecordDeclaration) =>
  declaration.subject[0]!.toLowerCase() + declaration.subject.slice(1);

/** Whether a record takes a capability. */
export const takes = (declaration: RecordDeclaration, capability: Capability) =>
  declaration.capabilities.includes(capability);

const base = () => ({
  id: uuidPk(),
  /** The tenant it belongs to (docs/tenancy.md). */
  tenantId: tenantColumn(),
  /** Who created it: `user:<id>` or `client:<id>`. */
  ownerId: text('owner_id').notNull(),
});
const teamColumns = () => ({ teamId: uuid('team_id') });
const searchColumns = () => ({ search: searchVector('search', () => sql``) });
type Empty = Record<never, never>;

/** The columns of a record's table, as its declaration says. */
export type RecordColumns<D extends RecordDeclaration> = ReturnType<
  typeof base
> &
  (D['team'] extends true ? ReturnType<typeof teamColumns> : Empty) &
  FieldColumns<D['fields']> &
  ReturnType<typeof timestamps> &
  (D['softDelete'] extends true ? ReturnType<typeof softDeletable> : Empty) &
  ('search' extends D['capabilities'][number]
    ? ReturnType<typeof searchColumns>
    : Empty);

/**
 * The record's table, behind row-level security like every feature table:
 * id, tenant, owner, (team,) the fields, timestamps, (the recycle bin,) (the
 * search vector over its `.searchable()` fields), with the owner's index,
 * the fields' unique indexes and reference keys, and the unique
 * (tenant_id, id) other features' keys point at.
 */
export function recordTable<const D extends RecordDeclaration>(declaration: D) {
  const searched = searchableFields(declaration.fields);
  const columns = {
    ...base(),
    ...(declaration.team && teamColumns()),
    ...fieldColumns(declaration.fields),
    ...timestamps(),
    ...(declaration.softDelete && softDeletable()),
    ...(takes(declaration, 'search') && {
      search: searchVector('search', () =>
        sql.raw(
          searched
            .map((name) => `coalesce("${columnName(name)}"::text, '')`)
            .join(` || ' ' || `),
        ),
      ),
    }),
  } as unknown as RecordColumns<D>;
  const name = declaration.table;
  return pgTable(name as D['table'], columns, (table) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = table as any;
    return [
      index(`${name}_owner_id_idx`).on(t.ownerId),
      ...(declaration.softDelete
        ? [index(`${name}_deleted_at_idx`).on(t.deletedAt)]
        : []),
      ...(takes(declaration, 'search')
        ? [index(`${name}_search_idx`).using('gin', t.search)]
        : []),
      ...fieldExtras(name, t, declaration.fields),
      ...tenantTable(name, t, { referenced: true }),
      ...(declaration.team
        ? [
            tenantReference(
              `${name}_team_fk`,
              [t.tenantId, t.teamId],
              [teams.tenantId, teams.id],
              'set null',
            ),
          ]
        : []),
    ];
  }).enableRLS();
}

/** A body's values as the table's columns (money, datetimes mapped): only what was sent. */
export const recordValues = (
  declaration: RecordDeclaration,
  dto: Record<string, unknown>,
) => fieldValues(declaration.fields, dto);

/** A record as the API shows it (and the audit log records it): money as objects, no search vector. */
export function recordView<
  D extends RecordDeclaration,
  Row extends Record<string, unknown>,
>(declaration: D, row: Row): Omit<FieldView<D['fields'], Row>, 'search'> {
  const { search: _search, ...view } = fieldView(
    declaration.fields,
    row,
  ) as Record<string, unknown>;
  return view as Omit<FieldView<D['fields'], Row>, 'search'>;
}
