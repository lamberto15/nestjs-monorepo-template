import { z } from 'zod';
import type {
  ApprovalCondition,
  StageMode,
  StageOutcome,
  StageVote,
} from './approval.types.js';

/**
 * The built-in stage modes and condition, registered by ApprovalsRegistry
 * like any project's own (docs/approvals.md, "Extending").
 */

/** The votes still counting: an approver closed out (the stage moved on) counts for nothing. */
const counting = (votes: readonly StageVote[]) =>
  votes.filter((vote) => vote.status !== 'closed');

/** `any`: the first decision decides the stage, whatever it is. */
export const ANY_MODE: StageMode<Record<string, never>> = {
  type: 'any',
  label: 'Any approver: the first decision decides',
  schema: z.object({}).strict(),
  outcome({ votes }) {
    const live = counting(votes);
    if (live.length === 0) {
      return 'unreachable';
    }
    const first = live
      .filter((vote) => vote.status !== 'pending' && vote.decidedAt)
      .sort((a, b) => a.decidedAt!.getTime() - b.decidedAt!.getTime())[0];
    return (first?.status as StageOutcome | undefined) ?? 'pending';
  },
};

/** `all`: every approver approves; one rejection (or request for changes) decides at once. */
export const ALL_MODE: StageMode<Record<string, never>> = {
  type: 'all',
  label: 'All approvers',
  schema: z.object({}).strict(),
  outcome({ votes }) {
    const live = counting(votes);
    if (live.some((vote) => vote.status === 'rejected')) {
      return 'rejected';
    }
    if (live.some((vote) => vote.status === 'changes_requested')) {
      return 'changes_requested';
    }
    if (live.length === 0) {
      return 'unreachable'; // everyone closed out: nobody left to approve
    }
    return live.every((vote) => vote.status === 'approved')
      ? 'approved'
      : 'pending';
  },
};

/**
 * `quorum`: `n` people approve. Never fewer: once `n` approvals can't be
 * reached (too many rejected, or too few approvers left), the stage is
 * rejected when someone rejected, `unreachable` otherwise (the request
 * fails; a stage that starts with fewer than `n` approvers is refused).
 * People count once, however many assignments they decided (their own and
 * those they stand in for). A request for changes decides at once.
 */
export const QUORUM_MODE: StageMode<{ n: number }> = {
  type: 'quorum',
  label: 'A quorum of approvers',
  schema: z.object({ n: z.number().int().min(1).max(100) }).strict(),
  outcome({ params, votes }) {
    const live = counting(votes);
    if (live.some((vote) => vote.status === 'changes_requested')) {
      return 'changes_requested';
    }
    const approvers = new Set(
      live
        .filter((vote) => vote.status === 'approved')
        .map((vote) => vote.decidedBy ?? vote.approverId),
    ).size;
    if (approvers >= params.n) {
      return 'approved';
    }
    const undecided = live.filter((vote) => vote.status === 'pending').length;
    if (approvers + undecided >= params.n) {
      return 'pending';
    }
    return live.some((vote) => vote.status === 'rejected')
      ? 'rejected'
      : 'unreachable';
  },
};

const COMPARISONS = [
  'eq',
  'ne',
  'gt',
  'gte',
  'lt',
  'lte',
  'in',
  'notIn',
  'exists',
] as const;

/** A dotted path into the payload: `amount`, `lines.0.total`. */
function valueAt(payload: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (value, key) =>
        value !== null && typeof value === 'object'
          ? (value as Record<string, unknown>)[key]
          : undefined,
      payload,
    );
}

/**
 * `payload`: compares a value of the proposed change.
 * `{ "type": "payload", "path": "amount", "op": "gt", "value": 1000 }`.
 */
export const PAYLOAD_CONDITION: ApprovalCondition<{
  path: string;
  op: (typeof COMPARISONS)[number];
  value?: unknown;
}> = {
  type: 'payload',
  label: 'A value of the proposed change',
  schema: z
    .object({
      path: z.string().min(1).max(200),
      op: z.enum(COMPARISONS),
      value: z.unknown().optional(),
    })
    .strict()
    .refine((params) => params.op === 'exists' || params.value !== undefined, {
      message: 'value is required for this op',
      path: ['value'],
    })
    .refine(
      (params) =>
        !['in', 'notIn'].includes(params.op) || Array.isArray(params.value),
      { message: 'in and notIn take a list', path: ['value'] },
    ),
  evaluate({ params, payload }) {
    const actual = valueAt(payload, params.path);
    const expected = params.value;
    switch (params.op) {
      case 'exists':
        return actual !== undefined && actual !== null;
      case 'eq':
        return actual === expected;
      case 'ne':
        return actual !== expected;
      case 'in':
        return (expected as unknown[]).includes(actual);
      case 'notIn':
        return !(expected as unknown[]).includes(actual);
      default: {
        // Numbers compare as numbers, anything else (ISO dates) as text.
        if (typeof actual === 'number' && typeof expected === 'number') {
          return compare(params.op, actual - expected);
        }
        if (typeof actual === 'string' && typeof expected === 'string') {
          return compare(
            params.op,
            actual < expected ? -1 : actual > expected ? 1 : 0,
          );
        }
        return false;
      }
    }
  },
};

const compare = (op: string, difference: number) =>
  op === 'gt'
    ? difference > 0
    : op === 'gte'
      ? difference >= 0
      : op === 'lt'
        ? difference < 0
        : difference <= 0;
