import { and, eq, exists, or, sql, type SQL } from 'drizzle-orm';
import { listQuery } from '../../core/http/list-query.js';
import { principalKey, type Principal } from '../../iam/auth/principal.js';
import { approvalSchema } from './approval.schemas.js';
import {
  APPROVAL_STATUSES,
  approvalAssignments,
  approvalDelegations,
  approvalRequests,
} from './approvals.tables.js';

const r = approvalRequests;
const a = approvalAssignments;

/**
 * Pending on this user now: an assignment of the current stage, theirs or
 * of someone they stand in for (an active delegation).
 */
export function assignedTo(userId: string): SQL {
  return and(
    eq(r.status, 'pending'),
    exists(
      sql`(select 1 from ${a} where ${a.requestId} = ${r.id}
        and ${a.round} = ${r.round} and ${a.stage} = ${r.currentStage}
        and ${a.status} = 'pending'
        and (${a.approverId} = ${userId} or ${a.approverId} in (
          select ${approvalDelegations.fromUserId} from ${approvalDelegations}
          where ${approvalDelegations.toUserId} = ${userId}
            and ${approvalDelegations.startsAt} <= now() and ${approvalDelegations.endsAt} > now()
            and (${approvalDelegations.subject} is null or ${approvalDelegations.subject} = ${r.subject}))))`,
    ),
  )!;
}

/** Requests the principal takes part in: made them, was assigned, decided one, or may decide one now. */
export function participates(principal: Principal): SQL {
  if (principal.kind !== 'user') {
    return eq(r.requester, principalKey(principal));
  }
  return or(
    eq(r.requester, principalKey(principal)),
    exists(
      sql`(select 1 from ${a} where ${a.requestId} = ${r.id}
        and (${a.approverId} = ${principal.id} or ${a.decidedBy} = ${principal.id}))`,
    ),
    assignedTo(principal.id),
  )!;
}

/**
 * The inbox's filters, sorts and fields. `assignedToMe` and `requestedByMe`
 * depend on the caller: the list is made per request with them bound
 * (`approvalList(principal)`); `APPROVAL_LIST` documents it.
 */
export function approvalList(principal: Principal | null) {
  const mine = (condition: (principal: Principal) => SQL) => ({
    eq: (value: unknown) => {
      const matches = principal ? condition(principal) : sql`false`;
      return value ? matches : sql`not (${matches})`;
    },
  });
  return listQuery(
    {
      assignedToMe: {
        column: r.id,
        type: 'boolean',
        ops: ['eq'],
        conditions: mine((p) =>
          p.kind === 'user' ? assignedTo(p.id) : sql`false`,
        ),
      },
      requestedByMe: {
        column: r.requester,
        type: 'boolean',
        ops: ['eq'],
        conditions: mine((p) => eq(r.requester, principalKey(p))),
      },
      status: {
        column: r.status,
        type: 'enum',
        values: APPROVAL_STATUSES,
        ops: ['eq', 'in', 'notIn'],
      },
      subject: { column: r.subject, type: 'string', ops: ['eq', 'in'] },
      action: { column: r.action, type: 'string', ops: ['eq', 'in'] },
      recordId: { column: r.recordId, type: 'string', ops: ['eq'] },
      requester: {
        column: r.requester,
        type: 'string',
        ops: ['eq'],
        ref: 'principal',
      },
      dueAt: {
        column: r.dueAt,
        type: 'datetime',
        ops: ['lt', 'lte', 'gte', 'isNull'],
        sortable: true,
      },
      createdAt: {
        column: r.createdAt,
        type: 'datetime',
        ops: ['gt', 'gte', 'lt', 'lte', 'between'],
        sortable: true,
      },
      updatedAt: {
        column: r.updatedAt,
        type: 'datetime',
        ops: ['gt', 'gte', 'lt', 'lte', 'between'],
        sortable: true,
      },
    },
    { select: Object.keys(approvalSchema.shape) },
  );
}

/** For the docs of GET /approvals (the filters' parameters). */
export const APPROVAL_LIST = approvalList(null);
