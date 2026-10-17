import type { I18nService } from '@nestjs/i18n';
import { z } from 'zod';
import type { PlatformOptions } from '../platform.options.js';
import {
  type ApprovalContext,
  type ApprovalHandler,
  defineApproval,
  type StageMode,
} from './approval.types.js';
import { ApprovalsRegistry } from './approvals.registry.js';
import { flag } from '../settings/setting.types.js';

const EXPENSE = defineApproval({
  subject: 'Expense',
  action: 'submit',
  label: 'Submit an expense',
  payload: z.object({ amount: z.number() }),
  policy: {
    stages: [{ name: 'Manager', approvers: [{ type: 'pick', ids: ['u1'] }] }],
  },
});

const i18n = {
  translate: (key: string, options?: { args?: Record<string, unknown> }) =>
    `${key} ${JSON.stringify(options?.args ?? {})}`,
} as unknown as I18nService;

function registry(approvals = [EXPENSE]) {
  const made = new ApprovalsRegistry(
    { eventTypes: [], approvals } as PlatformOptions,
    i18n,
  );
  made.addRule({
    type: 'pick',
    label: 'Picked users',
    schema: z.object({ ids: z.array(z.string()).min(1) }).strict(),
    resolve: async ({ params }) => (params as { ids: string[] }).ids,
  });
  return made;
}

const handler: ApprovalHandler = {
  approval: EXPENSE,
  describe: async () => ({ title: 'x' }),
  onApproved: async () => undefined,
};

const context = (payload: Record<string, unknown>): ApprovalContext => ({
  subject: 'Expense',
  recordId: 'r1',
  action: 'submit',
  payload,
  requester: { kind: 'user', id: 'u0' },
  record: async () => null,
});

describe('ApprovalsRegistry', () => {
  it('parses a policy against the registered types, with their defaults', () => {
    const policy = registry().parsePolicy({
      stages: [{ name: 'Manager', approvers: [{ type: 'pick', ids: ['u1'] }] }],
    });
    expect(policy).toEqual({
      enabled: true,
      resubmitWithin: '30d',
      stages: [
        {
          name: 'Manager',
          approvers: [{ type: 'pick', ids: ['u1'] }],
          mode: { type: 'any' },
          onOverdue: 'expire',
        },
      ],
    });
  });

  it('names each wrong path: unknown types, bad parameters, timer rules', () => {
    const issues = (input: unknown) => {
      try {
        registry().parsePolicy(input);
        return [];
      } catch (error) {
        return (error as { getResponse(): { errors: { path: string }[] } })
          .getResponse()
          .errors.map((issue) => issue.path);
      }
    };
    expect(
      issues({
        stages: [
          {
            name: 'A',
            approvers: [{ type: 'nope' }, { type: 'pick', ids: [] }],
            mode: { type: 'quorum', n: 'two' },
          },
        ],
        when: {
          type: 'all',
          conditions: [{ type: 'payload', path: 'x', op: 'gt' }],
        },
      }).sort(),
    ).toEqual([
      'stages.0.approvers.0.type',
      'stages.0.approvers.1.ids',
      'stages.0.mode.n',
      'when.conditions.0.value',
    ]);
    expect(
      issues({
        stages: [
          {
            name: 'A',
            approvers: [{ type: 'pick', ids: ['u1'] }],
            remindAfter: '2d',
            dueAfter: '1d',
            onOverdue: 'escalate',
          },
        ],
      }).sort(),
    ).toEqual(['stages.0.escalateTo', 'stages.0.remindAfter']);
    expect(issues({ stages: [] })).toEqual(['stages']);
  });

  it('takes a project’s own stage mode', () => {
    // A weighted vote: approved once the approvals' weights reach the threshold.
    const weighted: StageMode<{
      threshold: number;
      weights: Record<string, number>;
    }> = {
      type: 'weighted',
      label: 'Weighted vote',
      schema: z.object({
        threshold: z.number().positive(),
        weights: z.record(z.string(), z.number()),
      }),
      outcome: ({ params, votes }) => {
        const weight = (status: string) =>
          votes
            .filter((vote) => vote.status === status)
            .reduce(
              (sum, vote) => sum + (params.weights[vote.approverId] ?? 1),
              0,
            );
        if (weight('approved') >= params.threshold) return 'approved';
        return weight('rejected') >= params.threshold ? 'rejected' : 'pending';
      },
    };
    const made = registry();
    made.addMode(weighted);
    const mode = { type: 'weighted', threshold: 3, weights: { boss: 3 } };
    made.parsePolicy({
      stages: [
        { name: 'Board', approvers: [{ type: 'pick', ids: ['boss'] }], mode },
      ],
    });
    const decided = (approverId: string, status: 'approved' | 'pending') => ({
      approverId,
      status,
      decidedAt: null,
      decidedBy: status === 'approved' ? approverId : null,
    });
    expect(
      made.outcome(mode, [
        decided('a', 'approved'),
        decided('boss', 'pending'),
      ]),
    ).toBe('pending');
    expect(
      made.outcome(mode, [
        decided('a', 'pending'),
        decided('boss', 'approved'),
      ]),
    ).toBe('approved');
    expect(() => made.addMode(weighted)).toThrow(
      'two stage modes are named "weighted"',
    );
  });

  it('evaluates conditions, all / any / not included', async () => {
    const made = registry();
    const big = { type: 'payload', path: 'amount', op: 'gt', value: 1000 };
    expect(await made.holds(null, context({ amount: 1 }))).toBe(true);
    expect(await made.holds(big, context({ amount: 1200 }))).toBe(true);
    expect(
      await made.holds(
        { type: 'not', condition: big },
        context({ amount: 1200 }),
      ),
    ).toBe(false);
    const either = {
      type: 'any',
      conditions: [
        big,
        { type: 'payload', path: 'urgent', op: 'eq', value: true },
      ],
    };
    expect(await made.holds(either, context({ amount: 5, urgent: true }))).toBe(
      true,
    );
    expect(
      await made.holds(
        { ...either, type: 'all' },
        context({ amount: 5, urgent: true }),
      ),
    ).toBe(false);
  });

  it('resolves the rules of a stage, once per user', async () => {
    const made = registry();
    expect(
      await made.resolve(
        [
          { type: 'pick', ids: ['u1', 'u2'] },
          { type: 'pick', ids: ['u2', 'u3'] },
        ],
        context({}),
      ),
    ).toEqual(['u1', 'u2', 'u3']);
  });

  it('checks the declarations at startup: a handler each, a valid default policy', () => {
    expect(() => registry().onApplicationBootstrap()).toThrow(
      '"Expense.submit" has no handler',
    );
    const made = registry();
    made.handle(handler);
    expect(() => made.onApplicationBootstrap()).not.toThrow();
    expect(() => made.handle(handler)).toThrow('two handlers');
    const broken = registry([
      {
        ...EXPENSE,
        policy: { stages: [{ name: 'X', approvers: [{ type: 'missing' }] }] },
      },
    ]);
    broken.handle({
      ...handler,
      approval: broken.declaration('Expense.submit')!,
    });
    expect(() => broken.onApplicationBootstrap()).toThrow(
      'stages.0.approvers.0.type',
    );
    expect(() =>
      registry().handle({
        ...handler,
        approval: { ...EXPENSE, action: 'other' },
      }),
    ).toThrow('no declaration');
  });

  it('refuses a setting requesters could set for themselves (a user scope)', () => {
    const switchable = registry([
      {
        ...EXPENSE,
        setting: flag({
          key: 'expenses.approval',
          label: 'Approval',
          default: true,
        }),
      },
    ]);
    switchable.handle({
      ...handler,
      approval: switchable.declaration('Expense.submit')!,
    });
    expect(() => switchable.onApplicationBootstrap()).toThrow(
      'can be set per user',
    );
    const safe = registry([
      {
        ...EXPENSE,
        setting: flag({
          key: 'expenses.approval',
          label: 'Approval',
          default: true,
          scopes: ['tenant', 'orgUnit'],
        }),
      },
    ]);
    safe.handle({ ...handler, approval: safe.declaration('Expense.submit')! });
    expect(() => safe.onApplicationBootstrap()).not.toThrow();
  });
});
