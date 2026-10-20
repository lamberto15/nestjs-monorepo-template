import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  index,
  jsonb,
  type PgTable,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
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
import { defineCustomFields } from '../custom-fields/custom-field.types.js';
import { columnName, type Fields, tableHolds } from '../fields/field.js';
import type { NumberingFieldKind } from '../sequences/naming-series.registry.js';
import {
  type FieldColumns,
  fieldColumns,
  fieldExtras,
  fieldSnapshot,
  fieldValues,
  fieldView,
  type FieldView,
  searchableFields,
} from '../fields/fields.js';
import {
  APPROVAL_ACTION,
  type RecordApproval,
  RESERVED_ACTIONS,
} from './record-approvals.js';
import type { RecordRouteSpec } from './record-routes.js';
import type { RecordSettingSpec } from './record-settings.js';

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
  'custom',
  'events',
  'numbered',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** How a numbered record's number reads (platform/sequences: `NextNumberOptions`). */
export interface RecordNumber {
  /** `INV` in `INV-2026-00042`. */
  prefix?: string;
  /** Starts over every year, the year in the number. Default: true. */
  perYear?: boolean;
  /** Digits, zero-padded. Default: 5. */
  width?: number;
}

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
  /**
   * May API clients (keys) use it? `'own'`: every client creates, reads,
   * changes and deletes the records it created (`mine`). Unset or `false`:
   * a client reaches it only through a role an administrator grants it.
   */
  clientAccess?: false | 'own';
  /**
   * The seed roles' grants (a tenant's starting roles): `standard`, the
   * default, is editors their own, team leads their teams' (with `team`),
   * viewers every record; `none` grants none: only administrators until
   * someone creates a role.
   */
  grants?: 'standard' | 'none';
  /**
   * With `numbered`: the human-readable number's format (`INV-2026-00042`;
   * default: the subject's initials as prefix, per year, 5 digits).
   */
  number?: RecordNumber;
  /**
   * Actions that need approval, by name (`publish`): the policy, the flag,
   * the route that asks (`POST /<path>/{id}/<action>`) and the handler are
   * derived; the feature writes what happens once approved
   * (`<item>.approvals.ts`). See record-approvals.ts.
   */
  approvals?: Record<string, RecordApproval>;
  /**
   * Settings and flags administrators change at runtime, by name
   * (`<path>.<name>` is the key): see record-settings.ts.
   */
  settings?: Record<string, RecordSettingSpec>;
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
  for (const action of Object.keys(declaration.approvals ?? {})) {
    if (!APPROVAL_ACTION.test(action) || RESERVED_ACTIONS.includes(action)) {
      throw new Error(
        `${declaration.subject}: "${action}" can't be an approval's action: a word like publish or markPaid, none of ${RESERVED_ACTIONS.join(', ')} (the record's own routes).`,
      );
    }
  }
  for (const name of Object.keys(declaration.settings ?? {})) {
    if (
      !APPROVAL_ACTION.test(name) ||
      Object.keys(declaration.approvals ?? {}).some(
        (action) => `${action}Approval` === name,
      )
    ) {
      throw new Error(
        `${declaration.subject}: "${name}" can't be a setting's name: a camelCase word, not <action>Approval (the approval's flag).`,
      );
    }
  }
  return declaration;
}

/** `Invoice` → `invoice`: notification types, i18n keys, document names. */
export const recordKey = (declaration: RecordDeclaration) =>
  declaration.subject[0]!.toLowerCase() + declaration.subject.slice(1);

/** The number's format with its defaults: the subject's initials (`InvoiceLine` → `IL`, `Invoice` → `INV`), per year, 5 digits. */
export const numberFormat = (declaration: RecordDeclaration) => {
  const words = declaration.subject.match(/[A-Z][a-z0-9]*/g) ?? [
    declaration.subject,
  ];
  const initials =
    words.length > 1
      ? words.map((word) => word[0]).join('')
      : declaration.subject.slice(0, 3);
  return {
    prefix: declaration.number?.prefix ?? initials.toUpperCase(),
    perYear: declaration.number?.perYear ?? true,
    width: declaration.number?.width ?? 5,
  };
};

/** How numbering reads each field kind from a create body; the others (long text, money, json, refs) a series can't use. */
const NUMBERING_KINDS: Partial<Record<string, NumberingFieldKind>> = {
  string: 'text',
  enum: 'text',
  int: 'number',
  decimal: 'number',
  date: 'date',
  datetime: 'datetime',
  bool: 'boolean',
};

/** The fields a numbered record's naming series may print, date by or test (platform/sequences). */
export const numberingFields = (declaration: RecordDeclaration) =>
  Object.fromEntries(
    Object.entries(declaration.fields).flatMap(([name, f]) => {
      const kind = NUMBERING_KINDS[(f as { kind: string }).kind];
      return kind ? [[name, kind]] : [];
    }),
  ) as Record<string, NumberingFieldKind>;

/**
 * The webhook event types a record's `events` capability declares:
 * `<item>.created`, `.updated`, `.deleted` (and `.restored` with a recycle
 * bin). `featureDeclarations` adds them to the platform's `eventTypes`.
 */
export const recordEventTypes = (declaration: RecordDeclaration) => {
  const key = recordKey(declaration);
  const event = (action: string) => ({
    type: `${key}.${action}`,
    description: `${declaration.subject} record ${action}.`,
    group: key,
  });
  return takes(declaration, 'events')
    ? [
        event('created'),
        event('updated'),
        event('deleted'),
        ...(declaration.softDelete ? [event('restored')] : []),
      ]
    : [];
};

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
const numberColumns = () => ({ number: text('number') });
const searchColumns = () => ({ search: searchVector('search', () => sql``) });
const customColumns = () => ({
  /** Custom field values by key (platform/custom-fields): checked against their definitions on every write. */
  custom: jsonb('custom')
    .$type<Record<string, unknown>>()
    .notNull()
    .default({}),
});
type Empty = Record<never, never>;

/** The columns of a record's table, as its declaration says. */
export type RecordColumns<D extends RecordDeclaration> = ReturnType<
  typeof base
> &
  (D['team'] extends true ? ReturnType<typeof teamColumns> : Empty) &
  FieldColumns<D['fields']> &
  ReturnType<typeof timestamps> &
  ('numbered' extends D['capabilities'][number]
    ? ReturnType<typeof numberColumns>
    : Empty) &
  (D['softDelete'] extends true ? ReturnType<typeof softDeletable> : Empty) &
  ('search' extends D['capabilities'][number]
    ? ReturnType<typeof searchColumns>
    : Empty) &
  ('custom' extends D['capabilities'][number]
    ? ReturnType<typeof customColumns>
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
    ...(takes(declaration, 'numbered') && numberColumns()),
    ...(takes(declaration, 'custom') && customColumns()),
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
  const built = pgTable(name as D['table'], columns, (table) => {
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
      ...fieldExtras(name, t, declaration.fields, declaration.softDelete),
      // Unique per tenant; empty for records from before the capability (a number is never reused).
      ...(takes(declaration, 'numbered')
        ? [uniqueIndex(`${name}_number_idx`).on(t.tenantId, t.number)]
        : []),
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
      ...(takes(declaration, 'custom')
        ? [index(`${name}_custom_idx`).using('gin', t.custom)]
        : []),
    ];
  }).enableRLS();
  TABLES.set(declaration, built as unknown as PgTable);
  tableHolds(built, declaration.subject);
  return built;
}

/** The tables `recordTable()` made, by declaration: what the platform reads a record's columns from. */
const TABLES = new WeakMap<RecordDeclaration, PgTable>();

/** The table of a record's declaration (made by `recordTable()` when the feature's tables load). */
export function recordTableOf(declaration: RecordDeclaration) {
  const table = TABLES.get(declaration);
  if (!table) {
    throw new Error(
      `${declaration.subject}: its table is not made yet (recordTable(${declaration.subject.toUpperCase()}) in its tables file).`,
    );
  }
  return table as PgTable & Record<string, AnyPgColumn>;
}

/**
 * The custom fields a record takes (custom), as the platform wants them
 * declared (PlatformModule.forRoot): values in the table's `custom` column.
 */
export function recordCustomFields(declaration: RecordDeclaration | undefined) {
  if (!declaration || !takes(declaration, 'custom')) return [];
  const table = recordTableOf(declaration);
  return [
    defineCustomFields({
      subject: declaration.subject,
      table,
      column: table.custom!,
    }),
  ];
}

/** The field-level permissions a record's capabilities bring (spread into the policy's `fields`): `custom` with custom fields. */
export const recordPermissionFields = (declaration: RecordDeclaration) => ({
  ...(takes(declaration, 'custom') && {
    // Every custom field at once: per-field permissions would need each key declared (docs/custom-fields.md).
    custom: { label: 'The custom fields' },
  }),
});

/** What the list's Swagger parameters add with custom fields: where the runtime ones come from. */
export const recordListDocs = (declaration: RecordDeclaration) =>
  takes(declaration, 'custom')
    ? `Custom fields (GET /v1/custom-fields?subject=${declaration.subject}) filter, sort and select like the fields above: \`custom.region=eu\`, \`custom.amount.gte=10\`, in \`filter\` and \`sort\` as \`custom.<key>\`, \`fields=custom.region\`.`
    : undefined;

/**
 * A body as the field-level check reads it: what was sent. An empty `custom`
 * sets nothing, so it needs no permission on the field.
 */
export function sentFields(dto: object): Record<string, unknown> {
  const sent: Record<string, unknown> = { ...dto };
  const custom = sent.custom;
  if (
    custom !== undefined &&
    custom !== null &&
    Object.keys(custom as object).length === 0
  ) {
    delete sent.custom;
  }
  return sent;
}

/** What a revision keeps: the fields as the API shows them, and the custom values (custom). */
export function recordSnapshot(
  declaration: RecordDeclaration,
  view: Record<string, unknown>,
) {
  return {
    ...fieldSnapshot(declaration.fields, view),
    ...(takes(declaration, 'custom') && { custom: view.custom ?? {} }),
  };
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
