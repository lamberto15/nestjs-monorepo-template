import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { TransactionHost } from '@nestjs-cls/transactional';
import { Webhooks } from '@nestjs/webhooks';
import { WorkflowClient } from '@nestjs/workflows';
import {
  and,
  eq,
  gt,
  inArray,
  isNull,
  lte,
  notInArray,
  or,
  sql,
} from 'drizzle-orm';
import type { Database, Transaction } from '../../core/database/drizzle.js';
import {
  database,
  type DrizzleTransactions,
  inTransaction,
} from '../../core/database/transactions.js';
import { SystemContext } from '../../iam/access/system-context.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import {
  principalKey,
  type Principal,
  type SystemPrincipal,
} from '../../iam/auth/principal.js';
import { apiClients, users } from '../../iam/iam.tables.js';
import type { NotificationType } from '../notifications/notification.types.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { APPROVALS_JOB } from '../platform.jobs.js';
import { Realtime } from '../realtime/realtime.service.js';
import {
  APPROVAL_REALTIME,
  type ApprovalEventType,
  stageDecided,
} from './approval-events.js';
import { type ApprovalPolicy, millis, type Typed } from './approval-policy.js';
import {
  type ApprovalActor,
  type ApprovalContext,
  type ApprovalHook,
  type ApprovalLifecycleEvent,
  type ApprovalOutcome,
  approvalKey,
  type Requester,
} from './approval.types.js';
import {
  approvalAssignments,
  approvalDelegations,
  approvalEvents,
  type ApprovalRequestRow,
  approvalRequests,
  type ApprovalStatus,
} from './approvals.tables.js';
import { ApprovalsRegistry } from './approvals.registry.js';

type Ending = Exclude<ApprovalStatus, 'pending'>;

/** The CLS key that marks a request's own outcome handler running (`applying()`). */
const APPLYING = Symbol('approvals.applying');

export const actorOf = (principal: Principal): ApprovalActor => ({
  key: principalKey(principal),
  name: principal.name,
});

/** What an ended (or sent back) request tells, per status. */
const ENDINGS: Record<
  Exclude<ApprovalStatus, 'pending'>,
  {
    hook: ApprovalHook;
    webhook: ApprovalEventType;
    notify?: NotificationType;
  }
> = {
  approved: {
    hook: 'approved',
    webhook: 'approval.approved',
    notify: 'approval.approved',
  },
  rejected: {
    hook: 'rejected',
    webhook: 'approval.rejected',
    notify: 'approval.rejected',
  },
  changes_requested: {
    hook: 'changesRequested',
    webhook: 'approval.changes-requested',
    notify: 'approval.changesRequested',
  },
  expired: {
    hook: 'expired',
    webhook: 'approval.expired',
    notify: 'approval.expired',
  },
  failed: {
    hook: 'failed',
    webhook: 'approval.failed',
    notify: 'approval.failed',
  },
  // The approvers still pending are told instead (below).
  cancelled: { hook: 'cancelled', webhook: 'approval.cancelled' },
};

/** Realtime pushes of a transaction: sent once it committed, so nobody hears of a change that rolled back. */
export class AfterCommit {
  readonly pushes: {
    to: Pick<Principal, 'kind' | 'id'>;
    event: string;
    data: unknown;
  }[] = [];

  push(to: Pick<Principal, 'kind' | 'id'>, event: string, data: unknown) {
    this.pushes.push({ to, event, data });
  }
}

/** `user:<id>` / `client:<id>` as a requester. */
export const requesterOf = (key: string): Requester => {
  const [kind, id] = key.split(':') as ['user' | 'client', string];
  if (kind !== 'user' && kind !== 'client') {
    // A request is asked for by, or on behalf of, a user or a client: never `system:…`.
    throw new Error(`An approval requester is a user or a client, not ${key}.`);
  }
  return { kind, id };
};

/** The request as the workflow plans it: its stages' timers, in milliseconds. */
export interface ApprovalPlan {
  stages: {
    remindAfterMs: number | null;
    dueAfterMs: number | null;
    escalate: boolean;
    escalationDueAfterMs: number | null;
  }[];
  resubmitWithinMs: number;
}

/**
 * What changes a request's state, in one place: a stage starting (its
 * approvers resolved and assigned), reminders, escalations, expiries, and
 * the end of a request with what it tells (notifications, webhooks,
 * realtime, the timeline, the audit log, the lifecycle listeners), each
 * in the transaction of the change. The workflow's steps call it
 * (ApprovalWorkflow), and so does ApprovalsService for the decisions
 * people make. It never imports either of them.
 */
@Injectable()
export class ApprovalEngine {
  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    readonly registry: ApprovalsRegistry,
    private readonly notifications: NotificationsService,
    private readonly webhooks: Webhooks<Transaction>,
    private readonly realtime: Realtime,
    private readonly audit: AuditService,
    private readonly workflows: WorkflowClient,
    private readonly cls: ClsService,
    private readonly system: SystemContext,
  ) {}

  /**
   * Who acts when no person does: the system principal the call runs as
   * (`system:approvals` in the workflow's steps; the job, e.g. account
   * deletion, that ended a request). Never a fallback: a request has a
   * principal and passes it (`by`), so nothing in a request is ever
   * recorded as the system (docs/permissions.md, "The system principal").
   */
  private systemPrincipal(): SystemPrincipal {
    const current = this.system.current();
    if (!current) {
      throw new Error(
        `Approvals: no system job is running (SystemContext.run) and no principal was passed: a request acts as its own principal, never as system:${APPROVALS_JOB.key}.`,
      );
    }
    return current;
  }

  /** The actor of an event: the person, or (null) the system job running. */
  private actorFor(by: Principal | null): ApprovalActor {
    return actorOf(by ?? this.systemPrincipal());
  }

  private readonly logger = new Logger('Approvals');

  /** The request whose outcome handler is running in this call, if any (`assertNotPending` lets it through). */
  applying(): string | undefined {
    return this.cls.isActive() ? this.cls.get(APPLYING) : undefined;
  }

  private get db() {
    return database(this.txHost);
  }

  /** Runs a change in a transaction, then sends what it pushes and wakes the relays. */
  async run<T>(work: (tx: Transaction, after: AfterCommit) => Promise<T>) {
    const after = new AfterCommit();
    const result = await inTransaction(this.txHost, (tx) => work(tx, after));
    for (const { to, event, data } of after.pushes) {
      this.realtime.toPrincipal(to, event, data);
    }
    this.notifications.deliverNow();
    this.webhooks.notify();
    return result;
  }

  /** The request, locked for the rest of the transaction: its changes take turns. */
  async lock(tx: Transaction, id: string) {
    const [row] = await tx
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, id))
      .for('update');
    return row;
  }

  /** What rules and conditions see of a request; the record is loaded once, when asked for. */
  context(row: {
    subject: string;
    recordId: string;
    action: string;
    payload: Record<string, unknown>;
    requester: string;
  }): ApprovalContext {
    const { handler } = this.registry.action(approvalKey(row));
    let record: Promise<Record<string, unknown> | null> | undefined;
    return {
      subject: row.subject,
      recordId: row.recordId,
      action: row.action,
      payload: row.payload,
      requester: requesterOf(row.requester),
      record: () =>
        (record ??= handler.record
          ? handler.record(row.recordId).catch((error: unknown) => {
              if (error instanceof NotFoundException) {
                return null;
              }
              throw error;
            })
          : Promise.resolve(null)),
    };
  }

  /**
   * The users the rules name who may decide: active, and never the
   * requester (no self-approval), in the order the rules named them.
   */
  async approvers(context: ApprovalContext, rules: readonly Typed[]) {
    const named = await this.registry.resolve(rules, context);
    const requester =
      context.requester.kind === 'user' ? context.requester.id : null;
    const candidates = named.filter((id) => id !== requester);
    if (!candidates.length) {
      return [];
    }
    const active = new Set(
      (
        await this.db
          .select({ id: users.id })
          .from(users)
          .where(and(inArray(users.id, candidates), eq(users.active, true)))
      ).map((row) => row.id),
    );
    return candidates.filter((id) => active.has(id));
  }

  /** The requester's display name: the user's or the API client's, as it is now. */
  async requesterName(requester: Requester) {
    const [row] =
      requester.kind === 'user'
        ? await this.db
            .select({ name: users.name })
            .from(users)
            .where(eq(users.id, requester.id))
        : await this.db
            .select({ name: apiClients.name })
            .from(apiClients)
            .where(eq(apiClients.id, requester.id));
    return row?.name ?? `${requester.kind}:${requester.id}`;
  }

  /** Who stands in for these users now (out of office), for requests of `subject`. */
  async delegatesOf(userIds: readonly string[], subject: string) {
    const map = new Map<string, string[]>();
    if (!userIds.length) {
      return map;
    }
    const rows = await this.db
      .select({
        from: approvalDelegations.fromUserId,
        to: approvalDelegations.toUserId,
      })
      .from(approvalDelegations)
      .where(
        and(
          inArray(approvalDelegations.fromUserId, [...userIds]),
          lte(approvalDelegations.startsAt, sql`now()`),
          gt(approvalDelegations.endsAt, sql`now()`),
          or(
            isNull(approvalDelegations.subject),
            eq(approvalDelegations.subject, subject),
          ),
        ),
      );
    for (const { from, to } of rows) {
      map.set(from, [...(map.get(from) ?? []), to]);
    }
    return map;
  }

  /** A line of the request's timeline. */
  async event(
    tx: Transaction,
    row: ApprovalRequestRow,
    type: string,
    actor: ApprovalActor,
    details?: Record<string, unknown>,
    stage?: number,
  ) {
    await tx.insert(approvalEvents).values({
      requestId: row.id,
      type,
      actor: actor.key,
      actorName: actor.name,
      round: row.round,
      stage: stage ?? null,
      details: details ?? null,
    });
  }

  /** The audit entry of a change: the person's, or (null) the system job's. */
  async record(
    tx: Transaction,
    by: Principal | null,
    action: string,
    row: ApprovalRequestRow,
    details: Record<string, unknown> = {},
    ip?: string,
  ) {
    const entry = {
      action,
      targetType: 'Approval',
      targetId: row.id,
      details: {
        subject: row.subject,
        recordId: row.recordId,
        action: row.action,
        ...details,
      },
      ip,
    };
    await this.audit.record(by ?? this.systemPrincipal(), entry, tx);
  }

  /** A webhook to the requesting API client (a user's requests have none). */
  async dispatch(
    tx: Transaction,
    row: ApprovalRequestRow,
    type: ApprovalEventType,
  ) {
    const requester = requesterOf(row.requester);
    if (requester.kind !== 'client') {
      return;
    }
    await this.webhooks.dispatch(tx, {
      type,
      tenant: requester.id,
      data: {
        requestId: row.id,
        subject: row.subject,
        recordId: row.recordId,
        action: row.action,
        status: row.status,
      },
    });
  }

  /** The notification data every approval type carries. */
  private data(row: ApprovalRequestRow) {
    return {
      requestId: row.id,
      subject: row.subject,
      action: row.action,
      title: row.title,
    };
  }

  /**
   * Assigns users to a stage (one row each; a user already assigned is
   * skipped) and tells them, and whoever stands in for them, by
   * notification and realtime.
   */
  async assign(
    tx: Transaction,
    after: AfterCommit,
    row: ApprovalRequestRow,
    stage: number,
    userIds: readonly string[],
    { escalated, type }: { escalated: boolean; type: NotificationType },
  ) {
    const created = userIds.length
      ? await tx
          .insert(approvalAssignments)
          .values(
            userIds.map((approverId) => ({
              requestId: row.id,
              round: row.round,
              stage,
              approverId,
              escalated,
            })),
          )
          .onConflictDoNothing()
          .returning()
      : [];
    const assigned = created.map((assignment) => assignment.approverId);
    const delegates = await this.delegatesOf(assigned, row.subject);
    const recipients = [
      ...new Set([...assigned, ...[...delegates.values()].flat()]),
    ];
    if (recipients.length) {
      await this.notifications.notify(tx, {
        type,
        to: recipients.map((id) => `user:${id}`),
        data: {
          ...this.data(row),
          by: row.requesterName,
          ...(type === 'approval.requested' && {
            stage: row.policy.stages[stage]!.name,
          }),
        },
        link: `/approvals/${row.id}`,
      });
    }
    for (const id of recipients) {
      after.push({ kind: 'user', id }, APPROVAL_REALTIME.assigned, {
        id: row.id,
        subject: row.subject,
        recordId: row.recordId,
        action: row.action,
        stage,
      });
    }
    if (created.length) {
      await this.registry.emit(
        'assigned',
        {
          request: row,
          actor: this.actorFor(null),
          stage,
          assignments: created,
        },
        tx,
      );
    }
    return created;
  }

  /** The request's stage plan (a workflow step: replays get the same). */
  async plan(requestId: string): Promise<ApprovalPlan | null> {
    const [row] = await this.db
      .select({ policy: approvalRequests.policy })
      .from(approvalRequests)
      .where(eq(approvalRequests.id, requestId));
    if (!row) {
      return null;
    }
    const ms = (duration?: string) => (duration ? millis(duration) : null);
    return {
      stages: row.policy.stages.map((stage) => ({
        remindAfterMs: ms(stage.remindAfter),
        dueAfterMs: ms(stage.dueAfter),
        escalate: stage.onOverdue === 'escalate',
        escalationDueAfterMs: ms(stage.escalationDueAfter),
      })),
      resubmitWithinMs: millis(row.policy.resubmitWithin),
    };
  }

  /**
   * What a step answers when the request is no longer at the point the
   * step expected: its real status when it ended (or was sent back), so
   * the workflow concludes with that; `raced` when it goes on (a decision's
   * or a resubmission's signal is on its way); `gone` when it was purged.
   * Steps run at least once: a retry after a committed attempt lands here
   * and answers what that attempt produced.
   */
  private where(
    row: ApprovalRequestRow | undefined,
    round: number,
  ): 'gone' | 'raced' | Ending {
    if (!row) {
      return 'gone';
    }
    if (row.round !== round || row.status === 'pending') {
      return 'raced';
    }
    return row.status;
  }

  /** The votes of a stage, for its mode. */
  async votes(tx: Transaction, row: ApprovalRequestRow, stage: number) {
    return tx
      .select({
        approverId: approvalAssignments.approverId,
        status: approvalAssignments.status,
        decidedAt: approvalAssignments.decidedAt,
        decidedBy: approvalAssignments.decidedBy,
      })
      .from(approvalAssignments)
      .where(
        and(
          eq(approvalAssignments.requestId, row.id),
          eq(approvalAssignments.round, row.round),
          eq(approvalAssignments.stage, stage),
        ),
      );
  }

  /**
   * Asks the stage's mode where the stage stands, and settles it when it is
   * decided: the outcome recorded, the workflow signalled, the request ended
   * (or, approved with stages left, the stage's other approvers closed out).
   * `unreachable` (too few approvers left) ends it as `failed`. After any
   * change to a stage's votes: a decision, an escalation, an approver
   * removed. In the change's transaction, on the locked row.
   */
  async settleStage(
    tx: Transaction,
    after: AfterCommit,
    row: ApprovalRequestRow,
    by: Principal | null,
    {
      decision = null,
      comment,
      ip,
      tolerant = false,
    }: {
      decision?: string | null;
      comment?: string;
      ip?: string;
      /** An ending nobody may refuse (an account deactivated or deleted): see `end`. */
      tolerant?: boolean;
    } = {},
  ): Promise<ApprovalRequestRow> {
    const stage = row.currentStage;
    const votes = await this.votes(tx, row, stage);
    const outcome = this.registry.outcome(
      row.policy.stages[stage]!.mode,
      votes,
    );
    const voters = votes
      .filter((vote) => vote.status !== 'closed')
      .map((vote) => vote.approverId);
    if (outcome === 'pending') {
      if (decision !== null) {
        // Someone decided and the stage goes on: the requester and its approvers hear of it.
        this.pushDecided(after, row, decision, voters);
      }
      return row;
    }
    const ending = outcome === 'unreachable' ? 'failed' : outcome;
    const [settled] = await tx
      .update(approvalRequests)
      .set({ stageOutcome: ending })
      .where(eq(approvalRequests.id, row.id))
      .returning();
    const key = `${row.id}:${row.round}:${stage}`;
    await this.workflows.signal(
      stageDecided,
      { outcome: ending },
      { key, id: key, transaction: tx },
    );
    const last = stage === row.policy.stages.length - 1;
    if (ending === 'approved' && !last) {
      // The stage's other approvers needn't decide; the workflow starts the next stage.
      await tx
        .update(approvalAssignments)
        .set({ status: 'closed' })
        .where(
          and(
            eq(approvalAssignments.requestId, row.id),
            eq(approvalAssignments.status, 'pending'),
          ),
        );
      await this.event(
        tx,
        settled!,
        'stage_approved',
        this.actorFor(by),
        {},
        stage,
      );
      this.pushDecided(after, settled!, decision, voters);
      return settled!;
    }
    return this.end(tx, after, settled!, ending, by, {
      ...(outcome === 'unreachable' && { reason: 'no_approvers' }),
      comment,
      ip,
      decision,
      voters,
      tolerant,
    });
  }

  /**
   * Whether every stage of a policy can be decided by the approvers its
   * rules name now (its mode, asked with every vote pending, isn't
   * `unreachable`): `request()` and resubmissions refuse otherwise (422).
   */
  async startable(context: ApprovalContext, policy: ApprovalPolicy) {
    for (const stage of policy.stages) {
      const ids = await this.approvers(context, stage.approvers);
      const pending = ids.map((approverId) => ({
        approverId,
        status: 'pending' as const,
        decidedAt: null,
        decidedBy: null,
      }));
      if (
        !ids.length ||
        this.registry.outcome(stage.mode, pending) === 'unreachable'
      ) {
        return { ok: false as const, stage: stage.name };
      }
    }
    return { ok: true as const };
  }

  /**
   * Starts a stage: resolves its approvers now (later role changes don't
   * change who decides it) and assigns them. A stage that finds nobody, or
   * too few for its mode, ends the request as `failed` (`no_approvers`).
   * `started`, or the request's status when it isn't pending any more.
   */
  startStage(
    requestId: string,
    round: number,
    stage: number,
  ): Promise<'started' | 'gone' | 'raced' | Ending> {
    return this.run(async (tx, after) => {
      const row = await this.lock(tx, requestId);
      if (!row || row.status !== 'pending' || row.round !== round) {
        return this.where(row, round);
      }
      if (row.currentStage === stage && row.stageStartedAt) {
        return 'started'; // a retried step: it committed before
      }
      const policyStage = row.policy.stages[stage]!;
      const ids = await this.approvers(
        this.context(row),
        policyStage.approvers,
      );
      if (!ids.length) {
        const ended = await this.end(
          tx,
          after,
          { ...row, currentStage: stage },
          'failed',
          null,
          { reason: 'no_approvers' },
        );
        return ended.status as Ending;
      }
      const now = new Date();
      const [started] = await tx
        .update(approvalRequests)
        .set({
          currentStage: stage,
          stageStartedAt: now,
          stageOutcome: null,
          dueAt: policyStage.dueAfter
            ? new Date(now.getTime() + millis(policyStage.dueAfter))
            : null,
        })
        .where(eq(approvalRequests.id, requestId))
        .returning();
      const assignments = await this.assign(tx, after, started!, stage, ids, {
        escalated: false,
        type: 'approval.requested',
      });
      await this.event(
        tx,
        started!,
        'stage_started',
        this.actorFor(null),
        { name: policyStage.name, approvers: ids },
        stage,
      );
      await this.registry.emit(
        'stageStarted',
        { request: started!, actor: this.actorFor(null), stage, assignments },
        tx,
      );
      // Too few for the mode (a quorum above the approvers found): it can't be decided.
      const settled = await this.settleStage(tx, after, started!, null);
      return settled.status === 'pending'
        ? 'started'
        : (settled.status as Ending);
    });
  }

  /** The request, still deciding this stage: none when it moved on (the step raced a decision). */
  private deciding(
    row: ApprovalRequestRow | undefined,
    round: number,
    stage: number,
  ) {
    return row &&
      row.status === 'pending' &&
      row.round === round &&
      row.currentStage === stage &&
      !row.stageOutcome
      ? row
      : undefined;
  }

  /** Reminds the approvers of a stage who haven't decided (once: a retry finds its reminder sent). */
  remind(
    requestId: string,
    round: number,
    stage: number,
  ): Promise<'reminded' | 'gone' | 'raced' | Ending> {
    return this.run(async (tx) => {
      const locked = await this.lock(tx, requestId);
      const row = this.deciding(locked, round, stage);
      if (!row) {
        return this.where(locked, round);
      }
      if (await this.happened(tx, row, 'reminded', stage)) {
        return 'reminded';
      }
      const pending = await this.pendingApprovers(tx, row, stage);
      const delegates = await this.delegatesOf(pending, row.subject);
      const recipients = [
        ...new Set([...pending, ...[...delegates.values()].flat()]),
      ];
      if (recipients.length) {
        await this.notifications.notify(tx, {
          type: 'approval.reminder',
          to: recipients.map((id) => `user:${id}`),
          data: { ...this.data(row), by: row.requesterName },
          link: `/approvals/${row.id}`,
        });
      }
      await this.event(
        tx,
        row,
        'reminded',
        this.actorFor(null),
        { approvers: pending },
        stage,
      );
      await this.registry.emit(
        'reminded',
        { request: row, actor: this.actorFor(null), stage },
        tx,
      );
      return 'reminded';
    });
  }

  /** Whether the timeline already has this event for the stage of this round. */
  private async happened(
    tx: Transaction,
    row: ApprovalRequestRow,
    type: string,
    stage: number,
  ) {
    const [found] = await tx
      .select({ id: approvalEvents.id })
      .from(approvalEvents)
      .where(
        and(
          eq(approvalEvents.requestId, row.id),
          eq(approvalEvents.round, row.round),
          eq(approvalEvents.stage, stage),
          eq(approvalEvents.type, type),
        ),
      )
      .limit(1);
    return !!found;
  }

  private async pendingApprovers(
    tx: Transaction,
    row: ApprovalRequestRow,
    stage: number,
  ) {
    const rows = await tx
      .select({ id: approvalAssignments.approverId })
      .from(approvalAssignments)
      .where(
        and(
          eq(approvalAssignments.requestId, row.id),
          eq(approvalAssignments.round, row.round),
          eq(approvalAssignments.stage, stage),
          eq(approvalAssignments.status, 'pending'),
        ),
      );
    return rows.map((assignment) => assignment.id);
  }

  /**
   * The stage is overdue: escalate (the `escalateTo` approvers take over
   * its undecided part) or expire the request. `escalated` while the stage
   * still waits; the request's status when it ended (the escalation can
   * decide the stage: a quorum it leaves out of reach); `raced` when a
   * decision got there first.
   */
  overdue(
    requestId: string,
    round: number,
    stage: number,
  ): Promise<'escalated' | 'gone' | 'raced' | Ending> {
    return this.run(async (tx, after) => {
      const locked = await this.lock(tx, requestId);
      const row = this.deciding(locked, round, stage);
      if (!row) {
        return this.where(locked, round);
      }
      const policyStage = row.policy.stages[stage]!;
      if (policyStage.onOverdue === 'escalate' && policyStage.escalateTo) {
        if (await this.happened(tx, row, 'escalated', stage)) {
          return 'escalated'; // a retried step: it committed before
        }
        const ids = await this.approvers(
          this.context(row),
          policyStage.escalateTo,
        );
        const assigned = new Set(
          (await this.votes(tx, row, stage)).map((vote) => vote.approverId),
        );
        if (ids.some((id) => !assigned.has(id))) {
          // The stage's undecided part goes to the escalation's approvers:
          // those who didn't answer in time are closed out (an `all` stage
          // then waits for the escalation's approvers, not for them).
          await tx
            .update(approvalAssignments)
            .set({ status: 'closed' })
            .where(
              and(
                eq(approvalAssignments.requestId, row.id),
                eq(approvalAssignments.round, row.round),
                eq(approvalAssignments.stage, stage),
                eq(approvalAssignments.status, 'pending'),
                notInArray(approvalAssignments.approverId, ids),
              ),
            );
          const assignments = await this.assign(tx, after, row, stage, ids, {
            escalated: true,
            type: 'approval.escalated',
          });
          const [escalated] = await tx
            .update(approvalRequests)
            .set({
              dueAt: policyStage.escalationDueAfter
                ? new Date(Date.now() + millis(policyStage.escalationDueAfter))
                : null,
            })
            .where(eq(approvalRequests.id, row.id))
            .returning();
          const approvers = assignments.map((a) => a.approverId);
          await this.event(
            tx,
            escalated!,
            'escalated',
            this.actorFor(null),
            { approvers },
            stage,
          );
          await this.record(tx, null, 'approval.escalated', escalated!, {
            stage,
            approvers,
          });
          await this.registry.emit(
            'escalated',
            {
              request: escalated!,
              actor: this.actorFor(null),
              stage,
              assignments,
            },
            tx,
          );
          // The votes changed: the stage may be decided now (or out of reach).
          const settled = await this.settleStage(tx, after, escalated!, null);
          if (settled.status !== 'pending') {
            return settled.status as Ending;
          }
          return settled.stageOutcome ? 'raced' : 'escalated';
        }
        // Nobody new to escalate to: the request expires.
      }
      const ended = await this.end(tx, after, row, 'expired', null, {
        reason: 'overdue',
      });
      return ended.status as Ending;
    });
  }

  /** After an escalation's own deadline: the request expires, unless decided meanwhile. */
  expireStage(
    requestId: string,
    round: number,
    stage: number,
  ): Promise<'gone' | 'raced' | Ending> {
    return this.run(async (tx, after) => {
      const locked = await this.lock(tx, requestId);
      const row = this.deciding(locked, round, stage);
      if (!row) {
        return this.where(locked, round);
      }
      const ended = await this.end(tx, after, row, 'expired', null, {
        reason: 'overdue',
      });
      return ended.status as Ending;
    });
  }

  /** Changes were requested and the requester never resubmitted: the request expires. */
  expireResubmission(
    requestId: string,
    round: number,
  ): Promise<'gone' | 'raced' | Ending> {
    return this.run(async (tx, after) => {
      const row = await this.lock(tx, requestId);
      if (!row || row.status !== 'changes_requested' || row.round !== round) {
        return this.where(row, round);
      }
      const ended = await this.end(tx, after, row, 'expired', null, {
        reason: 'not_resubmitted',
      });
      return ended.status as Ending;
    });
  }

  /**
   * The requests a user has a pending assignment in, in id order: every
   * transaction that locks several of them locks them in the same order,
   * so two deactivations (or deletions) at once can't deadlock.
   */
  pendingRequestsOf(db: Transaction | Database, userId: string) {
    return db
      .selectDistinct({ requestId: approvalAssignments.requestId })
      .from(approvalAssignments)
      .where(
        and(
          eq(approvalAssignments.approverId, userId),
          eq(approvalAssignments.status, 'pending'),
        ),
      )
      .orderBy(approvalAssignments.requestId);
  }

  /**
   * A user can't decide any more (their account deactivated or deleted):
   * their pending assignments are closed out and each stage they were in
   * is settled again (it may complete without them, or fail when too few
   * approvers are left). In the deactivation's or deletion's transaction;
   * `by` is who did it (the administrator deactivating them), or null
   * inside a job (account deletion), which is then the actor.
   */
  async release(tx: Transaction, userId: string, by: Principal | null) {
    const held = await this.pendingRequestsOf(tx, userId);
    const after = new AfterCommit(); // realtime is left out: the caller's transaction hasn't committed
    for (const { requestId } of held) {
      const locked = await this.lock(tx, requestId);
      if (!locked || locked.status !== 'pending' || locked.stageOutcome) {
        continue;
      }
      const closed = await tx
        .update(approvalAssignments)
        .set({ status: 'closed' })
        .where(
          and(
            eq(approvalAssignments.requestId, requestId),
            eq(approvalAssignments.round, locked.round),
            eq(approvalAssignments.stage, locked.currentStage),
            eq(approvalAssignments.approverId, userId),
            eq(approvalAssignments.status, 'pending'),
          ),
        )
        .returning({ id: approvalAssignments.id });
      if (!closed.length) {
        continue;
      }
      await this.event(
        tx,
        locked,
        'approver_removed',
        this.actorFor(by),
        { approverId: userId },
        locked.currentStage,
      );
      // Locking an account out can never be refused: listeners run in a savepoint here.
      await this.settleStage(tx, after, locked, by, { tolerant: true });
    }
    // Their delegations end with them, given and held.
    await tx
      .delete(approvalDelegations)
      .where(
        or(
          eq(approvalDelegations.fromUserId, userId),
          eq(approvalDelegations.toUserId, userId),
        ),
      );
  }

  /**
   * The request ended (or was sent back for changes): its status, its
   * stage's pending approvers closed out, and everything it tells. In the
   * transaction of the change that ended it.
   */
  async end(
    tx: Transaction,
    after: AfterCommit,
    row: ApprovalRequestRow,
    status: Exclude<ApprovalStatus, 'pending'>,
    by: Principal | null,
    {
      reason,
      comment,
      ip,
      decision = null,
      voters = [],
      tolerant = false,
    }: {
      reason?: string;
      comment?: string;
      ip?: string;
      /** The decision that ended it, for the realtime event. */
      decision?: string | null;
      /** The stage's approvers who decided, told by realtime too. */
      voters?: readonly string[];
      /**
       * An ending that must not be refused (an account deactivated or
       * deleted): the listeners run in a savepoint, and one that throws is
       * logged and skipped instead of rolling the ending back.
       */
      tolerant?: boolean;
    } = {},
  ) {
    const actor = this.actorFor(by);
    const closed = await tx
      .update(approvalAssignments)
      .set({ status: 'closed' })
      .where(
        and(
          eq(approvalAssignments.requestId, row.id),
          eq(approvalAssignments.status, 'pending'),
        ),
      )
      .returning({ approverId: approvalAssignments.approverId });
    const [ended] = await tx
      .update(approvalRequests)
      .set({
        status,
        currentStage: row.currentStage,
        // Sent back for changes, it stays open: it may come back.
        endedAt: status === 'changes_requested' ? null : new Date(),
        outcomeReason: reason ?? null,
      })
      .where(eq(approvalRequests.id, row.id))
      .returning();
    const ending = ENDINGS[status];
    await this.event(
      tx,
      ended!,
      status,
      actor,
      { ...(reason && { reason }), ...(comment && { comment }) },
      ended!.currentStage,
    );
    await this.record(
      tx,
      by,
      `approval.${status}`,
      ended!,
      { ...(reason && { reason }) },
      ip,
    );
    // What it tells (notifications, the webhook), in the transaction.
    const tell = async (t: Transaction) => {
      if (ending.notify) {
        await this.notifications.notify(t, {
          type: ending.notify,
          to: ended!.requester,
          data: {
            ...this.data(ended!),
            ...(ending.notify !== 'approval.expired' &&
              ending.notify !== 'approval.failed' && { by: actor.name }),
            ...((status === 'rejected' || status === 'changes_requested') && {
              comment: comment ?? '',
            }),
          },
          link: `/approvals/${ended!.id}`,
        });
      } else if (closed.length || actor.key !== ended!.requester) {
        // Withdrawn: the approvers still waiting are told they needn't decide,
        // and the requester when someone else (Approval.cancel) withdrew it.
        await this.notifications.notify(t, {
          type: 'approval.cancelled',
          to: [
            ...closed.map(({ approverId }) => `user:${approverId}`),
            ...(actor.key !== ended!.requester ? [ended!.requester] : []),
          ],
          data: { ...this.data(ended!), by: actor.name },
          link: `/approvals/${ended!.id}`,
        });
      }
      await this.dispatch(t, ended!, ending.webhook);
    };
    if (tolerant) {
      // A system ending (a deactivation): nothing it tells may refuse it.
      try {
        await tx.transaction((savepoint) =>
          tell(savepoint as unknown as Transaction),
        );
      } catch (error) {
        this.logger.error(
          `Telling of approval ${ended!.id}'s ending failed; the change went ahead: ${(error as Error).message}`,
          (error as Error).stack,
        );
      }
    } else {
      await tell(tx);
    }
    this.pushDecided(after, ended!, decision, [
      ...voters,
      ...closed.map((a) => a.approverId),
    ]);
    if (tolerant) {
      await this.emitTolerantly(ending.hook, { request: ended!, actor }, tx);
    } else {
      await this.registry.emit(ending.hook, { request: ended!, actor }, tx);
    }
    return ended!;
  }

  /** The listeners in a savepoint: one that throws is logged, its writes rolled back, the change goes on. */
  private async emitTolerantly(
    hook: ApprovalHook,
    event: ApprovalLifecycleEvent,
    tx: Transaction,
  ) {
    try {
      await tx.transaction((savepoint) =>
        this.registry.emit(hook, event, savepoint as unknown as Transaction),
      );
    } catch (error) {
      this.logger.error(
        `A "${hook}" listener failed for approval ${event.request.id}; the change went ahead: ${(error as Error).message}`,
        (error as Error).stack,
      );
    }
  }

  /** `approval.decided` to the requester and to these approvers: one event per change. */
  pushDecided(
    after: AfterCommit,
    row: ApprovalRequestRow,
    decision: string | null,
    approverIds: readonly string[],
  ) {
    const event = {
      id: row.id,
      status: row.status,
      round: row.round,
      stage: row.currentStage,
      decision,
    };
    after.push(requesterOf(row.requester), APPROVAL_REALTIME.decided, event);
    for (const id of new Set(approverIds)) {
      after.push({ kind: 'user', id }, APPROVAL_REALTIME.decided, event);
    }
  }

  /**
   * Runs the feature's handler of round `round`'s outcome (a workflow
   * step: at least once, so handlers are idempotent), then notes when it
   * did. Approved, the record's fingerprint is compared first: a record
   * changed since the request isn't applied, the request ends as `failed`
   * (`record_changed`) and `onFailed` runs instead. While the handler runs,
   * `assertNotPending` lets this request through (`applying()`), so a
   * handler may apply the change through the feature's own guarded writes.
   * `outcomeAppliedAt` is set only for a final outcome of the round it
   * concludes (a resubmission clears it). Answers the status it concluded,
   * or `gone` (purged with its record). The handlers act as `by`, the
   * person concluding it from a request (`abandon`), or (null) as the
   * system job running: `system:approvals` in the workflow.
   */
  async conclude(
    requestId: string,
    status: Ending,
    idempotencyKey: string,
    round: number,
    by: Principal | null = null,
  ): Promise<Ending | 'gone'> {
    let [row] = await this.db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, requestId));
    if (!row) {
      return 'gone';
    }
    // A step of an earlier round (resubmitted since): its own outcome, nothing of the new round's.
    const sameRound = row.round === round;
    const { handler, declaration } = this.registry.action(approvalKey(row));
    if (
      sameRound &&
      row.status === 'approved' &&
      !row.outcomeAppliedAt &&
      handler.fingerprint &&
      row.fingerprint !== null
    ) {
      const now = await handler.fingerprint(row.recordId);
      if (now !== row.fingerprint) {
        row = await this.run(async (tx, after) => {
          const locked = (await this.lock(tx, requestId))!;
          return locked.status === 'approved' && !locked.outcomeAppliedAt
            ? this.end(tx, after, locked, 'failed', null, {
                reason: 'record_changed',
              })
            : locked;
        });
      }
    }
    // The request's own status: a cancellation after changes were
    // requested, or a record that changed, concludes as what it became.
    const concluded =
      !sameRound || row.status === 'pending' ? status : (row.status as Ending);
    if (sameRound && row.outcomeAppliedAt && concluded === 'approved') {
      return concluded; // a retry: applied before
    }
    const outcome: ApprovalOutcome = {
      request: row,
      payload: declaration.payload.parse(row.payload),
      idempotencyKey,
      actor: by ?? this.systemPrincipal(),
    };
    await this.cls.run({ ifNested: 'inherit' }, async () => {
      this.cls.set(APPLYING, requestId);
      switch (concluded) {
        case 'approved':
          await handler.onApproved(outcome);
          break;
        case 'rejected':
          await handler.onRejected?.(outcome);
          break;
        case 'changes_requested':
          await handler.onChangesRequested?.(outcome);
          break;
        case 'cancelled':
          await handler.onCancelled?.(outcome);
          break;
        case 'expired':
          await handler.onExpired?.(outcome);
          break;
        case 'failed':
          await handler.onFailed?.(outcome);
          break;
      }
    });
    if (sameRound && concluded !== 'changes_requested') {
      await this.db
        .update(approvalRequests)
        .set({ outcomeAppliedAt: new Date() })
        .where(
          and(
            eq(approvalRequests.id, requestId),
            eq(approvalRequests.round, round),
            isNull(approvalRequests.outcomeAppliedAt),
            // Still what was concluded (the row's lock, in this statement):
            // an approval abandoned meanwhile isn't marked applied.
            eq(approvalRequests.status, concluded),
          ),
        );
    }
    return concluded;
  }

  /**
   * The approved outcome's handler gave up (its step's attempts ran out):
   * the request ends as `failed` (`apply_failed`), so the record isn't
   * locked for good, the requester is told and `onFailed` follows. The
   * request's status when it isn't approved-and-unapplied any more.
   */
  applyFailed(
    requestId: string,
    round: number,
  ): Promise<'gone' | 'raced' | Ending> {
    return this.run(async (tx, after) => {
      const row = await this.lock(tx, requestId);
      if (
        !row ||
        row.round !== round ||
        row.status !== 'approved' ||
        row.outcomeAppliedAt
      ) {
        return this.where(row, round);
      }
      const ended = await this.end(tx, after, row, 'failed', null, {
        reason: 'apply_failed',
      });
      return ended.status as Ending;
    });
  }
}
