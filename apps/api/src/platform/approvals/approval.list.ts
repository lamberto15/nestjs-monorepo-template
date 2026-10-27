import {
  and,
  eq,
  exists,
  gt,
  inArray,
  isNull,
  lte,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { QueryBuilder } from 'drizzle-orm/pg-core';
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
const qb = new QueryBuilder();

/** An assignment row of the request being filtered on, where `condition` holds. */
const anAssignment = (condition: SQL | undefined) =>
  exists(
    qb
      .select({ one: sql`1` })
      .from(a)
      .where(and(eq(a.requestId, r.id), condition)),
  );

/**
 * Pending on this user now: an assignment of the current stage, theirs or
 * of someone they stand in for (an active delegation).
 */
export function assignedTo(userId: string): SQL {
  const d = approvalDelegations;
  // Whose assignments this user decides now: their own, and those of
  // whoever delegated to them (an active delegation, for this subject or all).
  const standsInFor = qb
    .select({ id: d.fromUserId })
    .from(d)
    .where(
      and(
        eq(d.toUserId, userId),
        lte(d.startsAt, sql`now()`),
        gt(d.endsAt, sql`now()`),
        or(isNull(d.subject), eq(d.subject, r.subject)),
      ),
    );
  return and(
    eq(r.status, 'pending'),
    anAssignment(
      and(
        eq(a.round, r.round),
        eq(a.stage, r.currentStage),
        eq(a.status, 'pending'),
        or(eq(a.approverId, userId), inArray(a.approverId, standsInFor)),
      ),
    ),
  )!;
}

/**
 * Decided by this user: a decision of theirs on any stage of any round,
 * their own assignment or one they stood in for (`decidedBy`). The
 * inbox's history.
 */
export function decidedBy(userId: string): SQL {
  return anAssignment(eq(a.decidedBy, userId));
}

/** Requests the principal takes part in: made them, was assigned, decided one, or may decide one now. */
export function participates(principal: Principal): SQL {
  if (principal.kind !== 'user') {
    return eq(r.requester, principalKey(principal));
  }
  return or(
    eq(r.requester, principalKey(principal)),
    anAssignment(
      or(eq(a.approverId, principal.id), eq(a.decidedBy, principal.id)),
    ),
    assignedTo(principal.id),
  )!;
}

/**
 * The inbox's filters, sorts and fields. `assignedToMe`, `requestedByMe`
 * and `decidedByMe` depend on the caller: the list is made per request with them bound
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
      decidedByMe: {
        column: r.id,
        type: 'boolean',
        ops: ['eq'],
        conditions: mine((p) =>
          p.kind === 'user' ? decidedBy(p.id) : sql`false`,
        ),
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

/** The inbox's list, bound to a caller. */
export type ApprovalList = ReturnType<typeof approvalList>;

/** For the docs of GET /approvals (the filters' parameters). */
export const APPROVAL_LIST = approvalList(null);
