import {
  ALL_MODE,
  ANY_MODE,
  PAYLOAD_CONDITION,
  QUORUM_MODE,
} from './approval-modes.js';
import type { ApprovalContext, StageVote } from './approval.types.js';

let clock = 0;
const vote = (status: StageVote['status'], decidedBy?: string): StageVote => {
  const approverId = `u${++clock}`;
  const decided = status !== 'pending' && status !== 'closed';
  return {
    approverId,
    status,
    decidedAt: decided ? new Date(clock * 1000) : null,
    decidedBy: decided ? (decidedBy ?? approverId) : null,
  };
};

describe('stage modes', () => {
  it('any: the first decision decides, whatever it is', () => {
    expect(
      ANY_MODE.outcome({
        params: {},
        votes: [vote('pending'), vote('pending')],
      }),
    ).toBe('pending');
    expect(
      ANY_MODE.outcome({
        params: {},
        votes: [vote('pending'), vote('rejected')],
      }),
    ).toBe('rejected');
    const first = vote('approved');
    const second = vote('rejected');
    expect(ANY_MODE.outcome({ params: {}, votes: [second, first] })).toBe(
      'approved',
    );
    // Everyone closed out (removed, deactivated): nobody can decide it.
    expect(
      ANY_MODE.outcome({ params: {}, votes: [vote('closed'), vote('closed')] }),
    ).toBe('unreachable');
  });

  it('all: everyone approves; one rejection or request for changes decides at once', () => {
    expect(
      ALL_MODE.outcome({
        params: {},
        votes: [vote('approved'), vote('pending')],
      }),
    ).toBe('pending');
    expect(
      ALL_MODE.outcome({
        params: {},
        votes: [vote('approved'), vote('approved')],
      }),
    ).toBe('approved');
    expect(
      ALL_MODE.outcome({
        params: {},
        votes: [vote('approved'), vote('rejected')],
      }),
    ).toBe('rejected');
    expect(
      ALL_MODE.outcome({
        params: {},
        votes: [vote('pending'), vote('changes_requested')],
      }),
    ).toBe('changes_requested');
    // A closed-out approver counts for nothing, and nobody is no approval.
    expect(
      ALL_MODE.outcome({
        params: {},
        votes: [vote('approved'), vote('closed')],
      }),
    ).toBe('approved');
    expect(ALL_MODE.outcome({ params: {}, votes: [] })).toBe('unreachable');
    expect(ALL_MODE.outcome({ params: {}, votes: [vote('closed')] })).toBe(
      'unreachable',
    );
  });

  it('quorum: n approvals; rejected once n is out of reach', () => {
    const n2 = { n: 2 };
    expect(
      QUORUM_MODE.outcome({
        params: n2,
        votes: [vote('approved'), vote('pending'), vote('pending')],
      }),
    ).toBe('pending');
    expect(
      QUORUM_MODE.outcome({
        params: n2,
        votes: [vote('approved'), vote('rejected'), vote('approved')],
      }),
    ).toBe('approved');
    expect(
      QUORUM_MODE.outcome({
        params: n2,
        votes: [vote('rejected'), vote('pending'), vote('pending')],
      }),
    ).toBe('pending');
    expect(
      QUORUM_MODE.outcome({
        params: n2,
        votes: [vote('rejected'), vote('rejected'), vote('pending')],
      }),
    ).toBe('rejected');
    // Never lowered: fewer approvers than n can't reach it.
    expect(
      QUORUM_MODE.outcome({
        params: { n: 5 },
        votes: [vote('approved'), vote('approved')],
      }),
    ).toBe('unreachable');
    expect(
      QUORUM_MODE.outcome({
        params: { n: 3 },
        votes: [vote('pending'), vote('pending')],
      }),
    ).toBe('unreachable');
    // Closing out who didn't answer (an escalation) doesn't lower it either.
    expect(
      QUORUM_MODE.outcome({
        params: n2,
        votes: [vote('approved'), vote('closed'), vote('closed')],
      }),
    ).toBe('unreachable');
    // One person counts once: their own assignment and the one they stood in for.
    expect(
      QUORUM_MODE.outcome({
        params: n2,
        votes: [vote('approved', 'd'), vote('approved', 'd'), vote('pending')],
      }),
    ).toBe('pending');
    expect(QUORUM_MODE.schema.safeParse({ n: 0 }).success).toBe(false);
  });
});

describe('the payload condition', () => {
  const context = (payload: Record<string, unknown>) =>
    ({ payload }) as unknown as ApprovalContext;
  const holds = (
    params: Parameters<typeof PAYLOAD_CONDITION.evaluate>[0]['params'],
    payload: Record<string, unknown>,
  ) => PAYLOAD_CONDITION.evaluate({ ...context(payload), params });

  it('compares numbers, text and lists at a dotted path', () => {
    expect(
      holds({ path: 'amount', op: 'gt', value: 1000 }, { amount: 1200 }),
    ).toBe(true);
    expect(
      holds({ path: 'amount', op: 'gt', value: 1000 }, { amount: 1000 }),
    ).toBe(false);
    expect(
      holds({ path: 'amount', op: 'lte', value: 1000 }, { amount: 1000 }),
    ).toBe(true);
    expect(
      holds(
        { path: 'lines.0.total', op: 'gte', value: 5 },
        { lines: [{ total: 5 }] },
      ),
    ).toBe(true);
    expect(
      holds(
        { path: 'due', op: 'lt', value: '2026-12-01' },
        { due: '2026-11-30' },
      ),
    ).toBe(true);
    expect(
      holds({ path: 'kind', op: 'in', value: ['a', 'b'] }, { kind: 'b' }),
    ).toBe(true);
    expect(
      holds({ path: 'kind', op: 'notIn', value: ['a', 'b'] }, { kind: 'b' }),
    ).toBe(false);
    expect(holds({ path: 'note', op: 'exists' }, {})).toBe(false);
    // A number compared with text is never true.
    expect(
      holds({ path: 'amount', op: 'gt', value: 10 }, { amount: '20' }),
    ).toBe(false);
  });

  it('checks its parameters', () => {
    expect(
      PAYLOAD_CONDITION.schema.safeParse({ path: 'a', op: 'gt' }).success,
    ).toBe(false);
    expect(
      PAYLOAD_CONDITION.schema.safeParse({ path: 'a', op: 'in', value: 1 })
        .success,
    ).toBe(false);
    expect(
      PAYLOAD_CONDITION.schema.safeParse({ path: 'a', op: 'exists' }).success,
    ).toBe(true);
  });
});
