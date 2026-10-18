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
import { escapeLike, listQuery } from '../../core/http/list-query.js';
import { auditLog, memberships, userTeams, users } from '../iam.tables.js';

/** Members of these teams (directly, not of the teams below them). */
const inTeams = (teamIds: string[]) =>
  exists(
    sql`(select 1 from ${userTeams} where ${and(
      eq(userTeams.userId, users.id),
      inArray(userTeams.teamId, teamIds),
    )})`,
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
    // A team's members (`?teamId=`): those in it, not in the teams below
    // it. Row-level security keeps user_teams to the tenant.
    teamId: {
      column: users.id,
      type: 'uuid',
      ops: ['eq', 'in'],
      ref: 'team',
      conditions: {
        eq: (value) => inTeams([value as string]),
        in: (value) => inTeams(value as string[]),
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
      'teamIds',
    ],
  },
);

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
    targetType: {
      column: auditLog.targetType,
      type: 'string',
      ops: ['eq', 'in', 'isNull'],
    },
    targetId: { column: auditLog.targetId, type: 'string', ops: ['eq'] },
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
      'actor',
      'actorLabel',
      'action',
      'targetType',
      'targetId',
      'details',
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
