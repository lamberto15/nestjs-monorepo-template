import { Inject, Injectable, Logger } from '@nestjs/common';
import { type SQL, sql } from 'drizzle-orm';
import type { Principal } from '../auth/principal.js';
import { IAM_OPTIONS, type IamOptions } from '../iam.options.js';
import {
  definePermissions,
  type AccessContext,
  type ConditionTemplate,
  type MongoQuery,
  type PermissionInput,
  type PermissionsDefinition,
  type SeedRole,
  type SubjectDefinition,
  type SystemJobDefinition,
  isAll,
} from './permissions.js';
import { IAM_SYSTEM_JOBS } from '../iam.jobs.js';

/** IAM's own subject: who may run access control. */
export const ACCESS_PERMISSIONS = definePermissions({
  subjects: {
    Access: {
      label: 'Access control',
      conditions: {},
      actions: {
        manageRoles: { label: 'Create, edit and delete roles', conditions: [] },
        manageUsers: {
          label: 'Create users, assign roles, reset passwords',
          conditions: [],
        },
        manageClients: {
          label: 'Create API clients, rotate and revoke their keys',
          conditions: [],
        },
        manageTeams: {
          label: 'Create, move and delete teams (what "in my teams" covers)',
          conditions: [],
        },
        manageCustomFields: {
          label:
            'Add, change, reorder and deactivate custom fields (the fields administrators add to notes and other records)',
          conditions: [],
        },
        manageSettings: {
          label:
            'Set settings and feature flags for everyone, a team or a user (platform/settings)',
          conditions: [],
        },
        manageTags: {
          label:
            'Create, rename, recolour and delete the tags records carry (platform/tags)',
          conditions: [],
        },
        readAudit: { label: 'Read the audit log', conditions: [] },
        manageTenants: {
          label:
            "Create tenants (the deployment's operators: only in the operator tenant)",
          conditions: [],
        },
        impersonate: {
          label: 'Act as another user (support), never as an administrator',
          conditions: [],
        },
      },
    },
  },
  systemJobs: IAM_SYSTEM_JOBS,
});

/** A system job's key: lowercase words joined by `-`, groups by `.`. */
const JOB_KEY =
  /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*)*$/;

/**
 * Every permission that exists: IAM's own, and those the other groups and
 * the features declared (`IamModule.forRoot({ permissions })`). It validates
 * what the access API receives, and renders stored permissions as CASL
 * conditions (record checks) and as SQL (lists).
 */
@Injectable()
export class PermissionCatalog {
  readonly subjects: Record<string, SubjectDefinition>;
  readonly clientPermissions: PermissionInput[];
  readonly seedRoles: SeedRole[];
  /** The jobs that run as the system principal, by key. */
  readonly systemJobs: ReadonlyMap<string, SystemJobDefinition>;

  constructor(@Inject(IAM_OPTIONS) options: IamOptions) {
    const all: PermissionsDefinition[] = [
      ACCESS_PERMISSIONS,
      ...options.permissions,
    ];
    this.subjects = {};
    for (const definition of all) {
      for (const [name, subject] of Object.entries(definition.subjects)) {
        if (this.subjects[name]) {
          throw new Error(`Permission subject ${name} is declared twice.`);
        }
        this.subjects[name] = subject;
      }
    }
    this.clientPermissions = all.flatMap((d) => d.clientPermissions ?? []);
    // Seed roles of one key from several declarations are one role (each
    // feature adds its permissions to `editor`, `viewer`…): the first
    // declaration's name and description, every declaration's permissions.
    const roles = new Map<string, SeedRole>();
    for (const role of all.flatMap((d) => d.seedRoles ?? [])) {
      const seen = roles.get(role.key);
      roles.set(
        role.key,
        seen
          ? { ...seen, permissions: [...seen.permissions, ...role.permissions] }
          : role,
      );
    }
    this.seedRoles = [...roles.values()];
    for (const permission of [
      ...this.clientPermissions,
      ...this.seedRoles.flatMap((role) => role.permissions),
    ]) {
      const result = this.validate(permission);
      if (!result.ok) {
        throw new Error(`Invalid declared permission: ${result.error}`);
      }
    }
    const jobs = new Map<string, SystemJobDefinition>();
    for (const job of all.flatMap((d) => d.systemJobs ?? [])) {
      if (!JOB_KEY.test(job.key)) {
        throw new Error(
          `System job "${job.key}": a key is lowercase words joined by "-" (and "." between groups).`,
        );
      }
      if (jobs.has(job.key)) {
        throw new Error(`System job ${job.key} is declared twice.`);
      }
      const permissions = job.permissions.map((permission) => {
        // Nothing implicit: a job says what it does, never "everything".
        if (isAll(permission)) {
          throw new Error(
            `System job ${job.key} declares all.manage: declare what it does instead.`,
          );
        }
        const result = this.validate(permission);
        if (!result.ok) {
          throw new Error(`System job ${job.key}: ${result.error}`);
        }
        return result.value;
      });
      jobs.set(job.key, { ...job, permissions });
    }
    this.systemJobs = jobs;
  }

  /** A declared system job, or undefined. */
  systemJob(key: string): SystemJobDefinition | undefined {
    return this.systemJobs.get(key);
  }

  /** Checks a permission against the catalog, and normalizes its parameters. */
  validate(
    input: PermissionInput,
  ): { ok: true; value: PermissionInput } | { ok: false; error: string } {
    const subject = this.subjects[input.subject];
    if (!subject) {
      return { ok: false, error: `Unknown subject ${input.subject}.` };
    }
    const action = subject.actions[input.action];
    if (!action) {
      return {
        ok: false,
        error: `Unknown action ${input.action} on ${input.subject}.`,
      };
    }
    const conditions: PermissionInput['conditions'] = [];
    for (const condition of input.conditions) {
      if (!action.conditions.includes(condition.key)) {
        return {
          ok: false,
          error: `Condition ${condition.key} isn't available for ${input.subject}.${input.action}.`,
        };
      }
      const template = subject.conditions[condition.key];
      if (template.params) {
        const parsed = template.params.safeParse(condition.params ?? {});
        if (!parsed.success) {
          return {
            ok: false,
            error: `Condition ${condition.key}: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`,
          };
        }
        conditions.push({
          key: condition.key,
          params: parsed.data as Record<string, unknown>,
        });
      } else {
        conditions.push({ key: condition.key });
      }
    }
    // Left out (or null): every field. []: none of the restrictable ones.
    let fields: string[] | null = null;
    if (input.fields) {
      const unknown = input.fields.filter((field) => !subject.fields?.[field]);
      if (unknown.length) {
        return {
          ok: false,
          error: `${input.subject} has no restrictable field ${unknown.join(', ')}.`,
        };
      }
      fields = [...new Set(input.fields)];
    }
    return { ok: true, value: { ...input, conditions, fields } };
  }

  /** The CASL condition of a stored permission, for this principal; `undefined` when it has none. */
  caslConditions(
    principal: Principal,
    permission: PermissionInput,
    context: AccessContext,
  ): MongoQuery | undefined {
    if (!permission.conditions.length) {
      return undefined;
    }
    return mergeConditions(
      permission.conditions.map((condition) =>
        this.template(permission, condition.key).casl(
          principal,
          condition.params,
          context,
        ),
      ),
    );
  }

  /** The SQL of a stored permission's conditions, for this principal (AND them). */
  sqlConditions(principal: Principal, permission: PermissionInput): SQL[] {
    return permission.conditions.map((condition) => {
      const template = this.template(permission, condition.key);
      if (!template.sql) {
        throw new Error(
          `Condition ${permission.subject}.${condition.key} has no SQL form: add sql() to filter lists with it.`,
        );
      }
      return template.sql(principal, condition.params);
    });
  }

  /** The system jobs as GET /access/catalog returns them: who acts without a user, and what each may do. */
  systemJobsView() {
    return [...this.systemJobs.values()].map((job) => ({
      key: job.key,
      actor: `system:${job.key}`,
      label: job.label,
      description: job.description,
      permissions: job.permissions.map((permission) => ({
        subject: permission.subject,
        action: permission.action,
        conditions: permission.conditions,
        fields: permission.fields ?? null,
      })),
    }));
  }

  /** The catalog as GET /access/catalog returns it. */
  view() {
    return Object.entries(this.subjects).map(([subject, definition]) => ({
      subject,
      label: definition.label,
      fields: Object.entries(definition.fields ?? {}).map(
        ([field, details]) => ({
          field,
          label: details.label,
          sensitive: details.sensitive ?? false,
        }),
      ),
      actions: Object.entries(definition.actions).map(([action, details]) => ({
        action,
        label: details.label,
        conditions: details.conditions.map((key) => {
          const template = definition.conditions[key];
          return {
            key,
            label: template.label,
            description: template.description,
            input: template.paramsInput ?? null,
          };
        }),
      })),
    }));
  }

  /** The fields of `subject` permissions grant one by one. */
  declaredFields(subject: string): string[] {
    return Object.keys(this.subjects[subject]?.fields ?? {});
  }

  /** The declared fields of `subject` marked sensitive (redacted in the audit log). */
  sensitiveFields(subject: string): string[] {
    return Object.entries(this.subjects[subject]?.fields ?? {})
      .filter(([, field]) => field.sensitive)
      .map(([name]) => name);
  }

  private template(
    permission: PermissionInput,
    key: string,
  ): ConditionTemplate {
    const template = this.subjects[permission.subject]?.conditions[key];
    if (template) {
      return template;
    }
    // A stored role naming a condition no declaration has (renamed, removed:
    // stored-renames.ts rewrites the renamed ones at migrate): it grants
    // nothing, rather than failing every check of the role's members.
    new Logger('Access').error(
      `A role's ${permission.subject}.${permission.action} names the unknown condition "${key}": it matches nothing.`,
    );
    return NO_MATCH;
  }
}

/** What an unknown condition stands for: no record, in CASL and in SQL. */
const NO_MATCH: ConditionTemplate = {
  label: 'Unknown condition',
  description: 'A stored condition no declaration has: it matches nothing.',
  casl: () => ({ id: { $in: [] } }),
  sql: () => sql`false`,
};

/**
 * All of the conditions, as one CASL condition. CASL's matcher has no `$and`,
 * so fields are merged; two conditions on one field narrow it: `$in` lists
 * intersect, `$lte` takes the lower bound, and differing equalities match
 * nothing.
 */
export function mergeConditions(parts: MongoQuery[]): MongoQuery {
  const merged: Record<string, Record<string, unknown>> = {};
  for (const part of parts) {
    for (const [field, raw] of Object.entries(part)) {
      const condition = isOperators(raw) ? raw : { $eq: raw };
      const current = merged[field];
      if (!current) {
        merged[field] = { ...condition };
        continue;
      }
      for (const [operator, value] of Object.entries(condition)) {
        if (!(operator in current)) {
          current[operator] = value;
        } else if (operator === '$in') {
          current.$in = (current.$in as unknown[]).filter((item) =>
            (value as unknown[]).includes(item),
          );
        } else if (operator === '$lte') {
          current.$lte = Math.min(current.$lte as number, value as number);
        } else if (current[operator] !== value) {
          current.$in = []; // Contradictory equalities: nothing matches.
        }
      }
    }
  }
  return merged;
}

const isOperators = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.keys(value).every((key) => key.startsWith('$'));
