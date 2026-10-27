import { Inject, Injectable } from '@nestjs/common';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { AccessService } from '../../iam/access/access.service.js';
import {
  type ActionDefinition,
  type ConditionTemplate,
  createdBy,
  definePermissions,
  type FieldDefinition,
  inMyUnits,
  inMyUnitsAndBelow,
  inUnitsILeadAndBelow,
  type PermissionInput,
  type SeedRole,
  type SystemJobDefinition,
} from '../../iam/access/permissions.js';
import type { Principal } from '../../iam/auth/principal.js';
import { type RecordDeclaration, recordPermissionFields } from './record.js';
import { RECORD_DECLARATION } from './record-contract.js';

/** What a feature adds to its records' standard permissions (recordPermissions). */
export interface RecordPermissionOptions {
  /** Field-level permissions: the fields a permission may grant one by one. */
  fields?: Record<string, FieldDefinition>;
  /** Conditions of the feature's own, besides `mine` (and the unit conditions). */
  conditions?: Record<string, ConditionTemplate>;
  /** Actions of its own, or a standard one replaced (its label, its conditions). */
  actions?: Record<string, ActionDefinition>;
  /** Added to what every API client may do. */
  clientPermissions?: PermissionInput[];
  /** Added to the seed roles (same key: merged). */
  seedRoles?: SeedRole[];
  systemJobs?: SystemJobDefinition[];
}

/** The standard actions a record's declaration gives it: `restore` with a recycle bin. */
const actionsOf = (declaration: RecordDeclaration) => [
  'read',
  'create',
  'update',
  'delete',
  ...(declaration.softDelete ? ['restore'] : []),
];

/**
 * A record's permissions (definePermissions), from its declaration
 * (record.ts): the conditions `mine` and, with units, `inMyUnits`,
 * `inMyUnitsAndBelow` and `inUnitsILeadAndBelow`; the
 * actions read, create, update, delete and, with a recycle bin, restore;
 * the field-level permissions of its capabilities (custom);
 * with `clientAccess: 'own'` an API client's own records (none by default);
 * the seed roles' grants (`grants`, standard unless 'none'): editors their
 * own, unit leads their units' (with units), viewers every one. Flipping
 * `softDelete`, `unit`, `clientAccess` or `grants` changes them with no
 * code of the feature's;
 * `options` adds the feature's own.
 *
 * ```ts
 * export const INVOICE_PERMISSIONS = recordPermissions(INVOICE, invoices, { fields: { total: { label: 'The total' } } });
 * ```
 */
export function recordPermissions(
  declaration: RecordDeclaration,
  table: { ownerId: AnyPgColumn; unitId?: AnyPgColumn },
  options: RecordPermissionOptions = {},
) {
  const { subject } = declaration;
  const nouns = declaration.path.replace(/-/g, ' ');
  const read = declaration.unit
    ? ['mine', 'inMyUnits', 'inMyUnitsAndBelow', 'inUnitsILeadAndBelow']
    : ['mine'];
  const own = (action: string): PermissionInput => ({
    subject,
    action,
    conditions: action === 'create' ? [] : [{ key: 'mine' }],
  });
  const actions = actionsOf(declaration);
  return definePermissions({
    subjects: {
      [subject]: {
        label: `${nouns[0]!.toUpperCase()}${nouns.slice(1)}`,
        // Its noun and path: `Purchase order`, `Purchase orders`.
        names: {
          singular: `${declaration.noun[0]!.toUpperCase()}${declaration.noun.slice(1)}`,
          plural: `${nouns[0]!.toUpperCase()}${nouns.slice(1)}`,
        },
        // Field-level: those of its capabilities (custom), and its own.
        fields: { ...recordPermissionFields(declaration), ...options.fields },
        conditions: {
          mine: createdBy('ownerId', table.ownerId),
          ...(declaration.unit && {
            inMyUnits: inMyUnits('unitId', table.unitId!),
            inMyUnitsAndBelow: inMyUnitsAndBelow('unitId', table.unitId!),
            inUnitsILeadAndBelow: inUnitsILeadAndBelow('unitId', table.unitId!),
          }),
          ...options.conditions,
        },
        actions: {
          read: { label: `See ${nouns}`, conditions: read },
          create: { label: `Create ${nouns}`, conditions: [] },
          update: { label: `Change ${nouns}`, conditions: ['mine'] },
          delete: { label: `Delete ${nouns}`, conditions: ['mine'] },
          ...(declaration.softDelete && {
            restore: {
              label: `See deleted ${nouns} and restore them`,
              conditions: read,
            },
          }),
          ...options.actions,
        },
      },
    },
    // What every API client may do, on top of its roles: its own records
    // (clientAccess: 'own'; by default none, a role grants it).
    clientPermissions: [
      ...(declaration.clientAccess === 'own' ? actions.map(own) : []),
      ...(options.clientPermissions ?? []),
    ],
    // Added to the roles every tenant starts with (iam/access/seed-roles.ts: merged by key).
    seedRoles: [
      ...(declaration.grants === 'none'
        ? []
        : standardRoles(declaration, actions.map(own))),
      ...(options.seedRoles ?? []),
    ],
    ...(options.systemJobs && { systemJobs: options.systemJobs }),
  });
}

/** The seed roles' grants of `grants: 'standard'`: editors their own, unit leads their units' (with units), viewers every record. */
function standardRoles(
  declaration: RecordDeclaration,
  own: PermissionInput[],
): SeedRole[] {
  const { subject } = declaration;
  return [
    {
      key: 'editor',
      name: 'Editor',
      description: 'Writes records and changes their own.',
      permissions: own,
    },
    ...(declaration.unit
      ? [
          {
            key: 'unit-lead',
            name: 'Unit lead',
            description:
              'Sees the records of the units they lead and every unit below them.',
            permissions: [
              {
                subject,
                action: 'read',
                conditions: [{ key: 'inUnitsILeadAndBelow' }],
              },
            ],
          },
        ]
      : []),
    {
      key: 'viewer',
      name: 'Viewer',
      description: 'Sees every record, changes nothing.',
      permissions: [{ subject, action: 'read', conditions: [] }],
    },
  ];
}

/** The fields of a record its standard conditions read. */
export interface RecordConditionFields {
  ownerId: string;
  unitId?: string | null;
  deletedAt?: Date | null;
}

/**
 * A record's policy (`@Policy()`, @nestjs/authorization): each standard
 * action checked by AccessService against the record's fields, as the
 * declaration has them (the unit with units, the recycle bin's
 * `deletedAt`, which refuses all but restore). The feature's policy
 * extends it: a rule of its own overrides an action, or adds one.
 *
 * ```ts
 * @Policy()
 * export class InvoicePolicy extends RecordPolicy {}
 * ```
 */
@Injectable()
export abstract class RecordPolicy {
  constructor(
    protected readonly access: AccessService,
    @Inject(RECORD_DECLARATION)
    protected readonly declaration: RecordDeclaration,
  ) {}

  create(user: Principal | null) {
    return this.access.can(user, 'create', this.declaration.subject);
  }

  read(user: Principal | null, row: RecordConditionFields) {
    return this.check(user, 'read', row);
  }

  update(user: Principal | null, row: RecordConditionFields) {
    return this.check(user, 'update', row);
  }

  delete(user: Principal | null, row: RecordConditionFields) {
    return this.check(user, 'delete', row);
  }

  /** Out of the recycle bin (declared with `softDelete`; refused without one). */
  restore(user: Principal | null, row: RecordConditionFields) {
    return this.check(user, 'restore', row);
  }

  /** Whether `user` may do `action` with the record. */
  protected check(
    user: Principal | null,
    action: string,
    row: RecordConditionFields,
  ) {
    return this.access.can(
      user,
      action,
      this.declaration.subject,
      this.conditionFields(row),
    );
  }

  /**
   * The fields the conditions read. Override (spreading this) when a
   * condition of the feature's reads another one.
   */
  protected conditionFields(
    row: RecordConditionFields,
  ): Record<string, unknown> {
    return {
      ownerId: row.ownerId,
      ...(this.declaration.unit && { unitId: row.unitId }),
      ...(this.declaration.softDelete && { deletedAt: row.deletedAt }),
    };
  }
}
