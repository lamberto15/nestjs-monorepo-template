import { eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { z } from 'zod';
import { principalKey, type Principal } from '../auth/principal.js';

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
 * permissions: the teams it belongs to, and every team below them.
 */
export interface AccessContext {
  teamIds: string[];
}

/** A condition an admin may attach to an action: typed parameters, rendered for CASL and for SQL. */
export interface ConditionTemplate<P = any> {
  label: string;
  description: string;
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

export interface SubjectDefinition {
  label: string;
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
  description: 'Only records this person (or API client) created.',
  casl: (principal) => ({ [field]: principalKey(principal) }),
  sql: (principal) => eq(column, principalKey(principal)),
});

/**
 * A reusable condition: records whose `field` (the Drizzle `column`) is one
 * of the principal's teams or a team below them. A team lead in
 * "Sales" sees what "Sales / North" and "Sales / South" own. Lists filter in
 * SQL through the closure table (no ids loaded); one record is checked
 * against the teams loaded with the principal's permissions.
 */
export const inMyTeams = (
  field: string,
  column: AnyPgColumn,
): ConditionTemplate => ({
  label: 'In my teams',
  description:
    'Only records of the teams I belong to, and of the teams below them.',
  casl: (_principal, _params, context) => ({
    [field]: { $in: context.teamIds },
  }),
  sql: (principal) =>
    principal.kind === 'user'
      ? inArray(
          column,
          sql`(select tree.descendant_id from team_tree tree
               join user_teams mine on mine.team_id = tree.ancestor_id
               where mine.user_id = ${principal.id})`,
        )
      : sql`false`,
});
