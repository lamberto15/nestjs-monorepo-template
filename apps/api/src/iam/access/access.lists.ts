import { listQuery } from '../../core/http/list-query.js';
import { auditLog, memberships, users } from '../iam.tables.js';

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
