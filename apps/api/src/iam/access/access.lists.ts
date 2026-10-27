import {
  type AnyColumn,
  and,
  eq,
  exists,
  ilike,
  inArray,
  or,
  sql,
} from 'drizzle-orm';
import { QueryBuilder } from 'drizzle-orm/pg-core';
import { SIGN_IN_ACTIONS } from '../audit/sign-in-actions.js';
import { escapeLike, listQuery } from '../../core/http/list-query.js';
import {
  apiClients,
  auditLog,
  memberships,
  organizationalUnitMemberships,
  users,
} from '../iam.tables.js';
import { currentMembership, subquery } from './permissions.js';

/** Current members of these units (directly, not of the units below them). */
const inUnits = (unitIds: string[]) =>
  inArray(
    users.id,
    subquery
      .select({ id: organizationalUnitMemberships.userId })
      .from(organizationalUnitMemberships)
      .where(
        and(
          inArray(organizationalUnitMemberships.unitId, unitIds),
          currentMembership(),
        ),
      ),
  );

/** What GET /access/users can be filtered, sorted and narrowed by. */
export const USER_LIST = listQuery(
  {
    email: {
      column: users.email,
      type: 'string',
      ops: ['eq', 'contains', 'startsWith', 'endsWith'],
      sortable: true,
    },
    name: {
      column: users.name,
      type: 'string',
      ops: ['contains', 'startsWith'],
      sortable: true,
    },
    // The membership in this tenant (an account in the list is active: a
    // deleted one has no memberships left).
    active: { column: memberships.active, type: 'boolean', ops: ['eq'] },
    emailVerified: {
      column: users.emailVerified,
      type: 'boolean',
      ops: ['eq'],
    },
    // A unit's current members (`?unitId=`): those in it, not in the units
    // below it. Row-level security keeps the memberships to the tenant.
    unitId: {
      column: users.id,
      type: 'uuid',
      ops: ['eq', 'in'],
      ref: 'unit',
      conditions: {
        eq: (value) => inUnits([value as string]),
        in: (value) => inUnits(value as string[]),
      },
    },
    createdAt: {
      column: users.createdAt,
      type: 'datetime',
      ops: ['gt', 'gte', 'lt', 'lte', 'between'],
      sortable: true,
    },
    updatedAt: {
      column: users.updatedAt,
      type: 'datetime',
      ops: ['gt', 'gte', 'lt', 'lte', 'between'],
      sortable: true,
    },
  },
  {
    select: [
      'id',
      'kind',
      'email',
      'name',
      'emailVerified',
      'locale',
      'timezone',
      'active',
      'hasPassword',
      'createdAt',
      'updatedAt',
      'roleIds',
      'roles',
      'unitIds',
    ],
  },
);

/**
 * Entries whose actor matches a LIKE pattern (escaped): its label as the
 * entry stored it (a user's address, `admin as user`, a client's name,
 * `System: …`), or the current name or address of the user, or the name of
 * the API client, it names. Only a member of the entry's tenant (a
 * membership in it) or a client of that tenant is looked up: the entries
 * are the caller's tenant's (row-level security), so another tenant's user
 * or client never matches, and a name or address is matched only for those
 * the access lists already show this caller (`AccessPolicy.open` covers
 * `readAudit`). An entry without a tenant (a sign-in) matches by its label
 * alone.
 */
const actorMatches = (pattern: string) =>
  or(
    ilike(auditLog.actorLabel, pattern),
    exists(
      new QueryBuilder()
        .select({ one: sql`1` })
        .from(users)
        .innerJoin(
          memberships,
          and(
            eq(memberships.userId, users.id),
            eq(memberships.tenantId, auditLog.tenantId),
          ),
        )
        .where(
          and(
            eq(auditLog.actor, sql`'user:' || ${users.id}::text`),
            or(ilike(users.name, pattern), ilike(users.email, pattern)),
          ),
        ),
    ),
    exists(
      new QueryBuilder()
        .select({ one: sql`1` })
        .from(apiClients)
        .where(
          and(
            eq(apiClients.tenantId, auditLog.tenantId),
            eq(auditLog.actor, sql`'client:' || ${apiClients.id}::text`),
            ilike(apiClients.name, pattern),
          ),
        ),
    ),
  )!;

/** What GET /access/audit can be filtered, sorted and narrowed by. */
export const AUDIT_LIST = listQuery(
  {
    action: {
      column: auditLog.action,
      type: 'string',
      ops: ['eq', 'in', 'notIn', 'startsWith'],
      sortable: true,
    },
    actor: {
      column: auditLog.actor,
      type: 'string',
      ops: ['eq', 'in'],
      ref: 'principal',
    },
    // Who acted, by name or address rather than key (actorMatches()):
    // `?actorLabel.contains=ada` finds Ada's entries by her name, her
    // address, or the label the entry stored.
    actorLabel: {
      column: auditLog.actorLabel,
      type: 'string',
      ops: ['eq', 'contains', 'startsWith'],
      conditions: {
        eq: (value) => actorMatches(escapeLike(value as string)),
        contains: (value) => actorMatches(`%${escapeLike(value as string)}%`),
        startsWith: (value) => actorMatches(`${escapeLike(value as string)}%`),
      },
    },
    targetType: {
      column: auditLog.targetType,
      type: 'string',
      ops: ['eq', 'in', 'isNull'],
    },
    targetId: { column: auditLog.targetId, type: 'string', ops: ['eq'] },
    // The entry's tenant: row-level security keeps GET /access/audit to one,
    // the consolidated read (docs/tenancy.md, "The tenant tree") spans the
    // subtree, so there it narrows the log to some of the tenants.
    tenantId: { column: auditLog.tenantId, type: 'uuid', ops: ['eq', 'in'] },
    at: {
      column: auditLog.at,
      type: 'datetime',
      ops: ['gt', 'gte', 'lt', 'lte', 'between'],
      sortable: true,
    },
  },
  {
    select: [
      'id',
      'tenantId',
      'at',
      'actor',
      'actorLabel',
      'actorName',
      'action',
      'targetType',
      'targetId',
      'details',
      'ip',
    ],
  },
);

/** Sign-in log entries only (the tenant's own, SignInLog): what every query of SIGN_IN_LIST starts from. */
export const SIGN_IN_ENTRIES = inArray(auditLog.action, [
  SIGN_IN_ACTIONS.succeeded,
  SIGN_IN_ACTIONS.failed,
]);
const signInMethod = sql<string>`${auditLog.details}->>'method'`;
const signInResult = sql<string>`case when ${auditLog.action} = ${SIGN_IN_ACTIONS.succeeded} then 'success' else 'failure' end`;
const signInResultIs = (value: unknown) =>
  value === 'success'
    ? eq(auditLog.action, SIGN_IN_ACTIONS.succeeded)
    : eq(auditLog.action, SIGN_IN_ACTIONS.failed);

/**
 * What GET /access/sign-ins can be filtered, sorted and narrowed by: the
 * sign-ins of this tenant's members (successes and wrong passwords), by
 * user, method and result. Rows of the audit log, which row-level security
 * keeps to the tenant; the scan is by `at` (audit_log_at_idx) under the
 * tenant's policy.
 */
export const SIGN_IN_LIST = listQuery(
  {
    user: {
      column: auditLog.actor,
      type: 'string',
      ops: ['eq', 'in'],
      ref: 'principal',
    },
    method: {
      column: signInMethod,
      type: 'string',
      ops: ['eq', 'in', 'startsWith'],
    },
    result: {
      column: signInResult,
      type: 'enum',
      values: ['success', 'failure'],
      ops: ['eq'],
      conditions: { eq: signInResultIs },
    },
    ip: { column: auditLog.ip, type: 'string', ops: ['eq'] },
    at: {
      column: auditLog.at,
      type: 'datetime',
      ops: ['gt', 'gte', 'lt', 'lte', 'between'],
      sortable: true,
    },
  },
  {
    select: [
      'id',
      'at',
      'user',
      'userLabel',
      'userName',
      'result',
      'method',
      'via',
      'userAgent',
      'ip',
    ],
  },
);

/** The union's alias: the list's fields name its columns. */
const PRINCIPALS = sql.identifier('principals');
const column = (name: string) => sql`${PRINCIPALS}.${sql.identifier(name)}`;
const label = column('label');
const email = column('email');
/** The union's id, for the cursor and the order (a uuid: users' and clients' never meet). */
export const PRINCIPALS_ID = column('id') as unknown as AnyColumn;

/**
 * What GET /access/principals can be searched, filtered and sorted by: the
 * tenant's members and API clients as one list (a union), for the pickers
 * of whom a setting's override, a rollout or a filter is for. `q` matches
 * a part of the name or of the address, whatever the case, its `%` and `_`
 * as the characters (escaped, as `contains` does).
 */
export const PRINCIPAL_LIST = listQuery(
  {
    q: {
      column: label,
      type: 'string',
      ops: ['eq'],
      conditions: {
        eq: (value) => {
          const pattern = `%${escapeLike(value as string)}%`;
          return or(ilike(label, pattern), ilike(email, pattern))!;
        },
      },
    },
    kind: {
      column: column('kind'),
      type: 'enum',
      values: ['user', 'client'],
      ops: ['eq'],
    },
    active: { column: column('active'), type: 'boolean', ops: ['eq'] },
    label: {
      column: label,
      type: 'string',
      ops: ['contains', 'startsWith'],
      sortable: true,
      // Whatever the case; its own key in the rows, so `label` stays as it is.
      sort: sql`lower(${label})`,
    },
  },
  { select: ['id', 'key', 'kind', 'label', 'email', 'active'] },
);
