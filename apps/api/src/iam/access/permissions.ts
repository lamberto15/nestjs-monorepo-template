import {
  and,
  eq,
  gt,
  inArray,
  isNull,
  lte,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { type AnyPgColumn, QueryBuilder } from 'drizzle-orm/pg-core';
import type { z } from 'zod';
import { principalKey, type Principal } from '../auth/principal.js';
import {
  organizationalUnitClosure,
  organizationalUnitMemberships,
  type UnitRole,
} from '../iam.tables.js';

/**
 * How a group or a feature declares its permissions. IAM knows none of them
 * in advance: AppModule hands every declaration to `IamModule.forRoot()`,
 * which merges them into the PermissionCatalog. Roles in the database only
 * combine what is declared here.
 *
 * ```ts
 * export const NOTE_PERMISSIONS = definePermissions({
 *   subjects: { Note: { label, conditions: { mine: … }, actions: { read: … } } },
 *   clientPermissions: [{ subject: 'Note', action: 'read', conditions: [{ key: 'mine' }] }],
 *   seedRoles: [{ key: 'editor', name: 'Editor', … }],
 * });
 * ```
 */

export type MongoQuery = Record<string, unknown>;

/**
 * What conditions may read besides the principal, loaded with its
 * permissions: its organizational units (current memberships only). Empty
 * for API clients, the system and break-glass reads.
 */
export interface AccessContext {
  /** The units it is a current member (or lead) of. */
  directUnitIds: string[];
  /** Those, and every unit below them. */
  unitIdsAndBelow: string[];
  /** The units it currently leads, and every unit below them. */
  ledUnitIdsAndBelow: string[];
}

/** The context of a principal with no units. */
export const NO_UNITS: AccessContext = {
  directUnitIds: [],
  unitIdsAndBelow: [],
  ledUnitIdsAndBelow: [],
};

/** A condition an admin may attach to an action: typed parameters, rendered for CASL and for SQL. */
export interface ConditionTemplate<P = any> {
  label: string;
  description: string;
  /**
   * A shared condition's texts in the i18n catalogs, when the subject has
   * none of its own: `permissions.conditions.<translation>` (createdBy:
   * `mine`, inMyUnits: `inMyUnits`). See PermissionCatalog.view().
   */
  translation?: string;
  /** Validates what the access API receives. */
  params?: z.ZodType<P>;
  /** For a frontend: the parameter's input type. */
  paramsInput?: { name: string; label: string; type: 'text' | 'cents' };
  /** The CASL condition, checked against a record's fields. */
  casl(principal: Principal, params: P, context: AccessContext): MongoQuery;
  /** The same condition as SQL, for lists filtered in the query (`AccessService.sqlFilter`). */
  sql?(principal: Principal, params: P): SQL;
}

export interface ActionDefinition {
  label: string;
  /** The keys of the subject's conditions this action may carry. */
  conditions: readonly string[];
}

/** A field a permission can grant on its own (field-level permissions). */
export interface FieldDefinition {
  label: string;
  /** Redacted in audit entries (`[redacted]`): personal or secret data. */
  sensitive?: boolean;
}

/** How texts name one record of a subject and several: `Note`, `Notes`. */
export interface SubjectNames {
  singular: string;
  plural: string;
}

export interface SubjectDefinition {
  label: string;
  /**
   * How a result list or a heading names one of its records and several
   * (GET /v1/search's `subjectLabel`), translated in `permissions.json`
   * (`<subject>.names.singular`, `.plural`). Default: the subject's name.
   */
  names?: SubjectNames;
  conditions: Record<string, ConditionTemplate>;
  actions: Record<string, ActionDefinition>;
  /**
   * The fields a permission may grant or withhold one by one: a permission
   * with `fields` grants only those (`Note.read` on `title` only, say).
   * Fields not listed here go with any permission on the subject.
   */
  fields?: Record<string, FieldDefinition>;
}

/** A permission as stored: an action on a subject, when every condition holds. */
export interface PermissionInput {
  subject: string;
  action: string;
  conditions: { key: string; params?: Record<string, unknown> }[];
  /**
   * Only these of the subject's declared (restrictable) fields: `[]` grants
   * none of them. Absent (or null): all of them.
   */
  fields?: string[] | null;
}

/** A role a new installation starts with; editable afterwards through the access API. */
export interface SeedRole {
  /** A stable name for the role in code and tests (`roles.key`); its id is a UUID. */
  key: string;
  name: string;
  description: string;
  permissions: PermissionInput[];
}

export interface PermissionsDefinition {
  subjects: Record<string, SubjectDefinition>;
  /**
   * What every API client may do, fixed in code (clients have no roles).
   * Conditions are read with the client as the principal: "Created by me"
   * means created by this client.
   */
  clientPermissions?: PermissionInput[];
  seedRoles?: SeedRole[];
  /**
   * The jobs that run as the system principal (`SystemContext.run()`),
   * each with what it may do: what `AccessService` answers for
   * `system:<key>`. A job not declared here can't run as the system.
   */
  systemJobs?: SystemJobDefinition[];
}

/**
 * Work that runs without a user, as the system principal `system:<key>`
 * (a cron job, the outbox relay's handler, a workflow's steps, the
 * first-boot seed). `permissions` is all it may do, read like an API
 * client's (conditions with the job as the principal: "Created by me" is
 * what the job created); never `all.manage`. `[]` for a job that checks
 * no permission (maintenance of its own tables), so a service it calls
 * that does check refuses it.
 */
export interface SystemJobDefinition {
  /** Lowercase, `-` and `.` (`account-deletion`): the audit log's `system:account-deletion`. */
  key: string;
  /** `System: <label>` in the audit log. */
  label: string;
  description: string;
  permissions: PermissionInput[];
}

/** Declares permissions with their types checked. */
export const definePermissions = <T extends PermissionsDefinition>(
  definition: T,
) => definition;

/** Declares a system job (list it in its group's `definePermissions({ systemJobs })`). */
export const defineSystemJob = <T extends SystemJobDefinition>(job: T) => job;

/** The built-in administrator's one permission: anything, on anything. */
export const ALL: PermissionInput = {
  subject: 'all',
  action: 'manage',
  conditions: [],
};

export const isAll = (permission: PermissionInput) =>
  permission.subject === 'all' && permission.action === 'manage';

/**
 * A reusable condition: records whose `field` (the Drizzle `column`) holds
 * the principal that created them, `user:<id>` or `client:<id>`.
 */
export const createdBy = (
  field: string,
  column: AnyPgColumn,
): ConditionTemplate => ({
  label: 'Created by me',
  translation: 'mine',
  description: 'Only records this person (or API client) created.',
  casl: (principal) => ({ [field]: principalKey(principal) }),
  sql: (principal) => eq(column, principalKey(principal)),
});

/** Which of a user's units: `below` adds every unit under them, `role` keeps those they hold that role in. */
export interface UnitsOfOptions {
  below?: boolean;
  role?: UnitRole;
}

/** Builds subqueries with no connection: they run inside the caller's query. */
export const subquery = new QueryBuilder();

/** A membership current at `at`: started (`validFrom`), and not ended (`validTo`, exclusive). */
export const currentMembership = (at = new Date()) =>
  and(
    lte(organizationalUnitMemberships.validFrom, at),
    or(
      isNull(organizationalUnitMemberships.validTo),
      gt(organizationalUnitMemberships.validTo, at),
    ),
  );

/**
 * The ids of the units `userId` is a current member of at `at` (from
 * `validFrom`, before `validTo`), as a subquery: `inArray(column,
 * unitIdsOf(id))`. Membership of a unit never implies its parent. Read in
 * the caller's transaction, so row-level security keeps it to the tenant.
 */
export function unitIdsOf(
  userId: string,
  options: UnitsOfOptions = {},
  at = new Date(),
) {
  const member = organizationalUnitMemberships;
  const current = and(
    eq(member.userId, userId),
    currentMembership(at),
    options.role ? eq(member.role, options.role) : undefined,
  );
  if (!options.below) {
    return subquery.select({ id: member.unitId }).from(member).where(current);
  }
  const tree = organizationalUnitClosure;
  return subquery
    .select({ id: tree.descendantId })
    .from(tree)
    .innerJoin(member, eq(member.unitId, tree.ancestorId))
    .where(current);
}

/** A unit condition: records whose `field` is one of `ids(context)`, in SQL the same subquery. */
const unitCondition =
  (
    texts: { label: string; translation: string; description: string },
    ids: (context: AccessContext) => string[],
    options: UnitsOfOptions,
  ) =>
  (field: string, column: AnyPgColumn): ConditionTemplate => ({
    ...texts,
    casl: (_principal, _params, context) => ({
      [field]: { $in: ids(context) },
    }),
    sql: (principal) =>
      principal.kind === 'user'
        ? inArray(column, unitIdsOf(principal.id, options))
        : sql`false`,
  });

/**
 * Reusable conditions on records whose `field` (the Drizzle `column`) holds
 * an organizational unit. Lists filter in SQL (no ids loaded); one record
 * is checked against the units loaded with the principal's permissions.
 * A unit's type grants nothing: only membership and leading do.
 *
 * `inMyUnits`: the units the user is a current member of, not those below.
 */
export const inMyUnits = unitCondition(
  {
    label: 'In my units',
    translation: 'inMyUnits',
    description: 'Only records of the units I belong to.',
  },
  (context) => context.directUnitIds,
  {},
);

/** The user's units and every unit below them: a member of "Sales" sees what "Sales / North" owns. */
export const inMyUnitsAndBelow = unitCondition(
  {
    label: 'In my units and below',
    translation: 'inMyUnitsAndBelow',
    description:
      'Only records of the units I belong to, and of the units below them.',
  },
  (context) => context.unitIdsAndBelow,
  { below: true },
);

/** The units the user currently leads and every unit below them. */
export const inUnitsILeadAndBelow = unitCondition(
  {
    label: 'In units I lead and below',
    translation: 'inUnitsILeadAndBelow',
    description:
      'Only records of the units I lead, and of the units below them.',
  },
  (context) => context.ledUnitIdsAndBelow,
  { below: true, role: 'lead' },
);
