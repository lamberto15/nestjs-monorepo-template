import {
  StepFailedError,
  Workflow,
  type WorkflowContext,
  type WorkflowRunner,
  type WorkflowRetryOptions,
} from '@nestjs/workflows';
import { SystemContext } from '../../iam/access/system-context.js';
import { APPROVALS_JOB } from '../platform.jobs.js';
import {
  ApprovalEngine,
  type ApprovalPlan,
} from './approval-engine.service.js';
import {
  type ApprovalWorkflowInput,
  requestCancelled,
  requestResubmitted,
  stageDecided,
} from './approval-events.js';
import { APPROVAL_STATUSES, type ApprovalStatus } from './approvals.tables.js';

type Ending = Exclude<ApprovalStatus, 'pending'>;
type StagePlan = ApprovalPlan['stages'][number];

/**
 * The outcome handlers' retries (they call the feature, maybe another
 * system): eight attempts over about twenty minutes before the request is
 * failed as `apply_failed`.
 */
const APPLY_RETRY: WorkflowRetryOptions = {
  attempts: 8,
  backoff: { delay: '10s', factor: 2, maxDelay: '1h' },
};

/** A step's answer that is a request's status: the process concludes with it. */
const isEnding = (answer: string): answer is Ending =>
  answer !== 'pending' &&
  (APPROVAL_STATUSES as readonly string[]).includes(answer);

/**
 * One instance per approval request (`approval-<request id>`): the
 * process from the first stage to the outcome, durable across restarts
 * and deploys. People's decisions are made in their requests
 * (ApprovalsService, which decides a stage's outcome in the request's
 * transaction, under a row lock, so two approvers can't both win) and
 * reach the instance as signals; the instance owns time and effects: it
 * starts each stage (assigning its approvers), reminds, escalates,
 * expires, and runs the feature's outcome handler, each in a step.
 *
 * Every wait races the stage's decision and a cancellation against the
 * stage's timers. Names carry the round and the stage, so a resubmitted
 * request journals each round apart.
 *
 * A step runs at least once (a retry after an attempt that committed but
 * wasn't journaled), so every step answers from the request's state: what
 * it did, or the status the request has now, which the process then
 * concludes with (never a guess).
 */
@Workflow('approval')
export class ApprovalWorkflow implements WorkflowRunner<
  ApprovalWorkflowInput,
  { status: Ending | 'gone' }
> {
  constructor(
    private readonly engine: ApprovalEngine,
    private readonly system: SystemContext,
  ) {}

  /**
   * A step's work as the system principal (`system:approvals`), in the
   * request's tenant (the input's `tenantId`, docs/tenancy.md): the actor
   * of what the engine records, and of the outcome handlers. The engine
   * opens its own transactions.
   */
  private asSystem<T>(tenantId: string, work: () => Promise<T>): Promise<T> {
    return this.system.run(APPROVALS_JOB, work, {
      transaction: false,
      tenantId,
    });
  }

  async run(
    ctx: WorkflowContext,
    { requestId, tenantId }: ApprovalWorkflowInput,
  ): Promise<{ status: Ending | 'gone' }> {
    const plan = await ctx.step('plan', () =>
      this.asSystem(tenantId, () => this.engine.plan(requestId)),
    );
    if (!plan) {
      return { status: 'gone' }; // purged with its record
    }
    for (let round = 0; ; round++) {
      let ending: Ending | 'gone' = 'approved';
      for (let stage = 0; stage < plan.stages.length; stage++) {
        ctx.setStatus({ round, stage });
        const started = await ctx.step(`start-${round}-${stage}`, () =>
          this.asSystem(tenantId, () =>
            this.engine.startStage(requestId, round, stage),
          ),
        );
        if (started === 'gone' || isEnding(started)) {
          ending = started;
          break;
        }
        const outcome = await this.stage(
          ctx,
          tenantId,
          requestId,
          round,
          stage,
          plan.stages[stage]!,
        );
        if (outcome !== 'approved') {
          ending = outcome;
          break;
        }
      }
      if (ending === 'gone') {
        return { status: 'gone' };
      }
      const status = ending;
      ctx.setStatus({ round, ending: status });
      const concluded = await this.conclude(
        ctx,
        tenantId,
        requestId,
        round,
        status,
      );
      if (concluded !== 'changes_requested') {
        return { status: concluded };
      }
      // Back to the requester: they resubmit (a new round), cancel, or let it expire.
      const next = await this.resubmission(
        ctx,
        tenantId,
        requestId,
        round,
        plan,
      );
      if (next === 'gone') {
        return { status: 'gone' };
      }
      if (next !== 'resubmitted') {
        const final = await ctx.step(
          `conclude-${round}-${next}`,
          ({ idempotencyKey }) =>
            this.asSystem(tenantId, () =>
              this.engine.conclude(requestId, next, idempotencyKey, round),
            ),
          { retry: APPLY_RETRY },
        );
        return { status: final };
      }
    }
  }

  /**
   * Runs the outcome's handler. When it gives up for good (its attempts ran
   * out), the request ends as `failed` (`apply_failed`), so the record isn't
   * locked for ever and the requester is told; `onFailed` follows.
   */
  private async conclude(
    ctx: WorkflowContext,
    tenantId: string,
    requestId: string,
    round: number,
    status: Ending,
  ): Promise<Ending | 'gone'> {
    try {
      return await ctx.step(
        `conclude-${round}`,
        ({ idempotencyKey }) =>
          this.asSystem(tenantId, () =>
            this.engine.conclude(requestId, status, idempotencyKey, round),
          ),
        { retry: APPLY_RETRY },
      );
    } catch (error) {
      if (!(error instanceof StepFailedError)) {
        throw error; // the engine's control flow (isWorkflowInterrupt), or a definition error
      }
      const failed = await ctx.step(`apply-failed-${round}`, () =>
        this.asSystem(tenantId, () =>
          this.engine.applyFailed(requestId, round),
        ),
      );
      if (failed !== 'failed') {
        return failed === 'gone' || failed === 'raced' ? 'gone' : failed;
      }
      return ctx.step(
        `conclude-${round}-apply-failed`,
        ({ idempotencyKey }) =>
          this.asSystem(tenantId, () =>
            this.engine.conclude(requestId, 'failed', idempotencyKey, round),
          ),
        { retry: APPLY_RETRY },
      );
    }
  }

  /** Waits for a stage's outcome, reminding and handling the deadline on the way. */
  private async stage(
    ctx: WorkflowContext,
    tenantId: string,
    requestId: string,
    round: number,
    stage: number,
    plan: StagePlan,
  ): Promise<Ending | 'gone'> {
    const name = `${round}-${stage}`;
    const ends = () => ({
      decided: ctx.signalWait(stageDecided, {
        key: `${requestId}:${round}:${stage}`,
      }),
      cancelled: ctx.signalWait(requestCancelled, { key: requestId }),
    });
    const ended = (result: { key: string; value: unknown }): Ending =>
      result.key === 'decided'
        ? (result.value as { outcome: Ending }).outcome
        : 'cancelled';
    // Timers count from the stage's start: journaled, so a replay waits for the same moments.
    const startedAt = ctx.now();
    if (
      plan.remindAfterMs !== null &&
      (plan.dueAfterMs === null || plan.remindAfterMs < plan.dueAfterMs)
    ) {
      const first = await ctx.waitForAny(`await-${name}-reminder`, {
        ...ends(),
        remind: ctx.timer({ until: startedAt + plan.remindAfterMs }),
      });
      if (first.key !== 'remind') {
        return ended(first);
      }
      const reminded = await ctx.step(`remind-${name}`, () =>
        this.asSystem(tenantId, () =>
          this.engine.remind(requestId, round, stage),
        ),
      );
      if (reminded === 'gone' || isEnding(reminded)) {
        return reminded;
      }
    }
    if (plan.dueAfterMs !== null) {
      const due = await ctx.waitForAny(`await-${name}-due`, {
        ...ends(),
        overdue: ctx.timer({ until: startedAt + plan.dueAfterMs }),
      });
      if (due.key !== 'overdue') {
        return ended(due);
      }
      const overdue = await ctx.step(`overdue-${name}`, () =>
        this.asSystem(tenantId, () =>
          this.engine.overdue(requestId, round, stage),
        ),
      );
      if (overdue === 'gone' || isEnding(overdue)) {
        return overdue;
      }
      if (overdue === 'escalated' && plan.escalationDueAfterMs !== null) {
        const escalatedAt = ctx.now();
        const late = await ctx.waitForAny(`await-${name}-escalated`, {
          ...ends(),
          overdue: ctx.timer({
            until: escalatedAt + plan.escalationDueAfterMs,
          }),
        });
        if (late.key !== 'overdue') {
          return ended(late);
        }
        const expired = await ctx.step(`expire-${name}`, () =>
          this.asSystem(tenantId, () =>
            this.engine.expireStage(requestId, round, stage),
          ),
        );
        if (expired === 'gone' || isEnding(expired)) {
          return expired;
        }
      }
      // Raced by a decision (or escalated without a deadline): its signal ends the wait below.
    }
    return ended(await ctx.waitForAny(`await-${name}`, ends()));
  }

  /** After changes were requested: resubmitted, or how it ended (cancelled, expired). */
  private async resubmission(
    ctx: WorkflowContext,
    tenantId: string,
    requestId: string,
    round: number,
    plan: ApprovalPlan,
  ): Promise<'resubmitted' | 'gone' | Ending> {
    const signals = () => ({
      resubmitted: ctx.signalWait(requestResubmitted, {
        key: `${requestId}:${round}`,
      }),
      cancelled: ctx.signalWait(requestCancelled, { key: requestId }),
    });
    const sentBackAt = ctx.now();
    const first = await ctx.waitForAny(`await-resubmit-${round}`, {
      ...signals(),
      expired: ctx.timer({ until: sentBackAt + plan.resubmitWithinMs }),
    });
    if (first.key !== 'expired') {
      return first.key;
    }
    const expired = await ctx.step(`expire-resubmit-${round}`, () =>
      this.asSystem(tenantId, () =>
        this.engine.expireResubmission(requestId, round),
      ),
    );
    if (expired === 'gone' || isEnding(expired)) {
      return expired;
    }
    // Raced by a resubmission: its signal ends the wait.
    const late = await ctx.waitForAny(
      `await-resubmit-${round}-late`,
      signals(),
    );
    return late.key;
  }
}
