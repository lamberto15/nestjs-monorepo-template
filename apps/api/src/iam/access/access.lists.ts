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
import {
  apiClients,
  auditLog,
  memberships,
  userTeams,
  users,
} from '../iam.tables.js';

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
      sql`(select 1 from ${users} inner join ${memberships} on ${and(
        eq(memberships.userId, users.id),
        eq(memberships.tenantId, auditLog.tenantId),
      )} where ${and(
        sql`${auditLog.actor} = 'user:' || ${users.id}::text`,
        or(ilike(users.name, pattern), ilike(users.email, pattern)),
      )})`,
    ),
    exists(
      sql`(select 1 from ${apiClients} where ${and(
        eq(apiClients.tenantId, auditLog.tenantId),
        sql`${auditLog.actor} = 'client:' || ${apiClients.id}::text`,
        ilike(apiClients.name, pattern),
      )})`,
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
      'actorName',
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
