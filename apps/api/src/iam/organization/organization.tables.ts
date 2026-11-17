import { isNull, sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { at, timestamps, uuidPk } from '../../core/database/columns.js';
import { closureTable } from '../../core/database/tree.js';
import {
  tenantColumn,
  tenantReference,
  tenantTable,
} from '../../core/tenancy/tenant-scope.js';
import { memberships } from '../iam.tables.js';

/** The kinds of organizational unit: labels of one tree, never a grant (docs/permissions.md). */
export const UNIT_TYPES = ['division', 'department', 'team'] as const;
export type UnitType = (typeof UNIT_TYPES)[number];

/** What a member is in a unit: a lead is context for policies, never a grant by itself. */
export const UNIT_ROLES = ['member', 'lead'] as const;
export type UnitRole = (typeof UNIT_ROLES)[number];

/**
 * The organization structure of a tenant: one tree of units (divisions,
 * departments, teams, in any order, at any depth). Users belong to units;
 * records can carry the unit that owns them, and the unit conditions
 * (`inMyUnits`, `inMyUnitsAndBelow`, `inUnitsILeadAndBelow`) grant what is
 * in them. A unit's name is unique among its siblings, ignoring case.
 */
export const organizationalUnits = pgTable.withRLS(
  'organizational_units',
  {
    id: uuidPk(),
    tenantId: tenantColumn(),
    /** Default `team`: the teams from before units became types keep their kind. */
    type: text('type', { enum: UNIT_TYPES }).notNull().default('team'),
    name: text('name').notNull(),
    /** Null: a top-level unit. The closure table holds every path. */
    parentId: uuid('parent_id'),
    ...timestamps(),
  },
  (table) => [
    index('organizational_units_parent_id_idx').on(table.parentId),
    // A top-level unit's parent counts as one value (the zero uuid), so two
    // roots can't share a name either.
    uniqueIndex('organizational_units_sibling_name_idx').on(
      table.tenantId,
      sql`coalesce(${table.parentId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
      sql`lower(${table.name})`,
    ),
    check(
      'organizational_units_type_check',
      sql`${table.type} in ('division', 'department', 'team')`,
    ),
    ...tenantTable('organizational_units', table, { referenced: true }),
    tenantReference(
      'organizational_units_parent_fk',
      [table.tenantId, table.parentId],
      [table.tenantId, table.id],
      'restrict',
    ),
  ],
);

/** Every (ancestor, descendant) pair of units: "under X" at any depth in one lookup. */
export const organizationalUnitClosure = closureTable(
  'organizational_unit_closure',
  () => organizationalUnits,
);

/**
 * Who belongs to which unit, as a member or its lead, from `validFrom`
 * until `validTo` (null: open-ended): an ended membership stays, so "who
 * was in Finance when this was approved" has an answer, and a re-org can
 * be dated ahead. At most one open membership per unit and user.
 * Membership of a unit says nothing of its parent.
 */
export const organizationalUnitMemberships = pgTable.withRLS(
  'organizational_unit_memberships',
  {
    id: uuidPk(),
    tenantId: tenantColumn(),
    unitId: uuid('unit_id').notNull(),
    userId: uuid('user_id').notNull(),
    role: text('role', { enum: UNIT_ROLES }).notNull().default('member'),
    validFrom: at('valid_from').notNull().defaultNow(),
    validTo: at('valid_to'),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('organizational_unit_memberships_open_idx')
      .on(table.tenantId, table.unitId, table.userId)
      .where(isNull(table.validTo)),
    index('organizational_unit_memberships_user_idx').on(
      table.userId,
      table.validFrom,
    ),
    index('organizational_unit_memberships_unit_idx').on(table.unitId),
    check(
      'organizational_unit_memberships_role_check',
      sql`${table.role} in ('member', 'lead')`,
    ),
    check(
      'organizational_unit_memberships_period_check',
      sql`${table.validTo} is null or ${table.validTo} > ${table.validFrom}`,
    ),
    ...tenantTable('organizational_unit_memberships', table),
    foreignKey({
      name: 'organizational_unit_memberships_membership_fk',
      columns: [table.tenantId, table.userId],
      foreignColumns: [memberships.tenantId, memberships.userId],
    }).onDelete('cascade'),
    tenantReference(
      'organizational_unit_memberships_unit_fk',
      [table.tenantId, table.unitId],
      [organizationalUnits.tenantId, organizationalUnits.id],
    ),
  ],
);
