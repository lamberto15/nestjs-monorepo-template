import type { z } from 'zod';
import type { Transaction } from '../../core/database/drizzle.js';
import type { Principal } from '../../iam/auth/principal.js';
import type { SettingDeclaration } from '../settings/setting.types.js';
import type { ApprovalPolicyInput } from './approval-policy.js';
import type {
  ApprovalAssignmentRow,
  ApprovalRequestRow,
  AssignmentStatus,
} from './approvals.tables.js';

/**
 * The extension points of approvals. Everything subject-specific comes
 * from the features: an approvable action is declared (`defineApproval()`,
 * handed to `PlatformModule.forRoot({ approvals })`), and its handlers,
 * approver rules, stage modes, conditions and lifecycle listeners are
 * providers that register themselves into `ApprovalsRegistry` from their
 * constructor, as the platform's built-in ones do (docs/approvals.md).
 */

/** Who asked: a principal, or its key (`user:<id>`, `client:<id>`), as a workflow step has it. */
export type Requester = Pick<Principal, 'kind' | 'id'> & { name?: string };

/** What a rule, a condition or a mode is told about the request. */
export interface ApprovalContext<P = Record<string, unknown>> {
  subject: string;
  recordId: string;
  action: string;
  payload: P;
  requester: Requester;
  /** The record (the feature's `record()`), loaded once and only when asked for. */
  record(): Promise<Record<string, unknown> | null>;
}

/**
 * Who may decide: a rule names users. Its parameters sit beside `type` in
 * a policy (`{ "type": "role", "role": "editor" }`) and are checked by
 * `schema` when a policy is declared or stored.
 *
 * ```ts
 * @Injectable()
 * export class CostCenterOwnerRule implements ApproverRule<{ center?: string }> {
 *   readonly type = 'cost-center-owner';
 *   readonly label = 'The owner of the cost center';
 *   readonly schema = z.object({ center: z.string().optional() });
 *   constructor(registry: ApprovalsRegistry, private readonly centers: CostCenters) { registry.addRule(this); }
 *   async resolve({ params, payload }) { return [await this.centers.ownerOf(params.center ?? payload.costCenter)]; }
 * }
 * ```
 */
export interface ApproverRule<P = any> {
  readonly type: string;
  readonly label: string;
  /** The rule's parameters (the policy entry without `type`). */
  readonly schema: z.ZodType<P>;
  /** The users' ids. The requester and inactive users are left out afterwards. */
  resolve(context: ApprovalContext & { params: P }): Promise<string[]>;
}

/** One approver's standing, as a stage mode sees it. */
export interface StageVote {
  approverId: string;
  status: AssignmentStatus;
  decidedAt: Date | null;
  /**
   * The person who decided: the approver, or their delegate. One person's
   * decision covers every assignment they hold or stand in for in a stage,
   * so count people (distinct `decidedBy`), not assignments.
   */
  decidedBy: string | null;
}

/**
 * A stage's state after a decision. `unreachable`: it can't be decided any
 * more (too few approvers left to reach it): the request ends as `failed`
 * (`no_approvers`). Also asked before a stage starts, with every vote
 * pending: `unreachable` then refuses the request (422) or fails it.
 */
export type StageOutcome =
  'pending' | 'approved' | 'rejected' | 'changes_requested' | 'unreachable';

/**
 * How a stage completes, from its approvers' decisions; asked after each
 * decision, in the decision's transaction. Must be a pure function of its
 * input.
 *
 * ```ts
 * export const WEIGHTED: StageMode<{ threshold: number; weights: Record<string, number> }> = {
 *   type: 'weighted', label: 'Weighted vote',
 *   schema: z.object({ threshold: z.number().positive(), weights: z.record(z.uuid(), z.number()) }),
 *   outcome({ params, votes }) { … },
 * };
 * ```
 */
export interface StageMode<P = any> {
  readonly type: string;
  readonly label: string;
  readonly schema: z.ZodType<P>;
  outcome(input: { params: P; votes: readonly StageVote[] }): StageOutcome;
}

/** Whether approval is needed at all (a policy's `when`). */
export interface ApprovalCondition<P = any> {
  readonly type: string;
  readonly label: string;
  readonly schema: z.ZodType<P>;
  evaluate(
    context: ApprovalContext & { params: P },
  ): boolean | Promise<boolean>;
}

/**
 * An approvable action, declared by its feature: `Note.publish`. The
 * declarations are handed to `PlatformModule.forRoot({ approvals })`.
 */
export interface ApprovalDeclaration<P extends Record<string, unknown> = any> {
  /** The record's permission subject: `Note`. */
  subject: string;
  /** The action on it: `publish`. */
  action: string;
  label: string;
  description?: string;
  /** The proposed change a request carries: checked on request and on resubmit. */
  payload: z.ZodType<P>;
  /** The default policy; administrators may store their own versions at runtime. */
  policy: ApprovalPolicyInput;
  /**
   * A boolean setting (or flag) of the feature that switches approval on
   * for a requester (teams, users, rollouts). Absent: always on, unless
   * the policy's `enabled` says otherwise.
   */
  setting?: SettingDeclaration<boolean>;
}

/** Declares an approvable action with its types checked. */
export const defineApproval = <P extends Record<string, unknown>>(
  declaration: ApprovalDeclaration<P>,
) => declaration;

/** The key of an action: `Note.publish`. */
export const approvalKey = (declaration: { subject: string; action: string }) =>
  `${declaration.subject}.${declaration.action}`;

/** What an outcome handler gets. */
export interface ApprovalOutcome<P = Record<string, unknown>> {
  request: ApprovalRequestRow;
  payload: P;
  /** The same across the step's attempts: pass it on to make the effect happen once. */
  idempotencyKey: string;
  /**
   * Who applies it: the system principal of the workflow
   * (`system:approvals`), or the person who concluded it from a request
   * (an administrator abandoning a stuck request: `onFailed`). The actor
   * of what the handler records (an audit entry, a revision), and the
   * principal of any permission it checks.
   */
  actor: Principal;
}

/**
 * The feature's side of an action: what the record is, and what happens
 * on each outcome. The handlers run as durable workflow steps, after the
 * outcome committed: a step runs at least once, so each must be
 * idempotent (do nothing when the effect is already there).
 *
 * ```ts
 * @Injectable()
 * export class NotePublishApproval implements ApprovalHandler<{ title: string }> {
 *   readonly approval = NOTE_PUBLISH_APPROVAL;
 *   constructor(registry: ApprovalsRegistry, private readonly notes: NotesService, private readonly publisher: NotePublisher) { registry.handle(this); }
 *   record(id) { return this.notes.findOne(id); }
 *   async describe(id, payload) { return { title: payload.title, link: `/notes/${id}` }; }
 *   async onApproved({ request, actor }) { await this.publisher.publish(request.recordId, actor); }
 * }
 * ```
 */
export interface ApprovalHandler<P extends Record<string, unknown> = any> {
  readonly approval: ApprovalDeclaration<P>;
  /** The record, for the `permission` rule and for conditions; null when it is gone. */
  record?(recordId: string): Promise<Record<string, unknown> | null>;
  /** What the record is called (and where it is in the web app), for the inbox and notifications. */
  describe(
    recordId: string,
    payload: P,
  ): Promise<{ title: string; link?: string }>;
  /**
   * The proposed change, read from the record itself: what is approved is
   * then what the record holds, never what a caller says it holds.
   * `request()` and resubmissions build it here (under the record's lock)
   * and refuse a payload a caller sends.
   */
  payload?(recordId: string): Promise<P>;
  /**
   * A fingerprint of the record's state (a hash, a revision number), taken
   * with the request and compared before `onApproved`: a record changed
   * since then (a write that went around `assertNotPending`) is not
   * applied; the request ends as `failed` (`record_changed`).
   */
  fingerprint?(recordId: string): Promise<string | null>;
  onApproved(outcome: ApprovalOutcome<P>): Promise<void>;
  onRejected?(outcome: ApprovalOutcome<P>): Promise<void>;
  onChangesRequested?(outcome: ApprovalOutcome<P>): Promise<void>;
  onCancelled?(outcome: ApprovalOutcome<P>): Promise<void>;
  onExpired?(outcome: ApprovalOutcome<P>): Promise<void>;
  onFailed?(outcome: ApprovalOutcome<P>): Promise<void>;
}

/**
 * Who did something to a request: a person or API client, or the system
 * (`system:approvals`, the workflow's timers; or the job that ended it,
 * e.g. `system:account-deletion`).
 */
export interface ApprovalActor {
  key: string;
  name: string;
}

/** What a lifecycle listener hears. */
export interface ApprovalLifecycleEvent {
  request: ApprovalRequestRow;
  actor: ApprovalActor;
  /** The stage it concerns, when one does. */
  stage?: number;
  /** stageStarted, escalated: the assignments made; decided: the decision. */
  assignments?: readonly ApprovalAssignmentRow[];
}

/** The moments listeners can hook into. */
export const APPROVAL_HOOKS = [
  'requested',
  'stageStarted',
  'assigned',
  'decided',
  'reminded',
  'escalated',
  'approved',
  'rejected',
  'changesRequested',
  'resubmitted',
  'cancelled',
  'expired',
  'failed',
] as const;
export type ApprovalHook = (typeof APPROVAL_HOOKS)[number];

/**
 * Hooks into every request's lifecycle, of every action or of some
 * subjects. Each runs inside the transaction of the change it reports:
 * throwing rolls the change back (an extra check: refuse a request), and
 * what it writes (an outbox message to sync another system) commits with
 * it. Keep them quick; hand slow work to a queue or the outbox.
 *
 * ```ts
 * @Injectable()
 * export class ErpSync implements ApprovalListener {
 *   readonly subjects = ['Expense'];
 *   constructor(registry: ApprovalsRegistry, private readonly outbox: Outbox<Transaction>) { registry.listen(this); }
 *   async approved({ request }, tx) { await this.outbox.add(tx, [{ topic: 'erp.expense-approved', payload: { id: request.recordId } }]); }
 * }
 * ```
 */
export type ApprovalListener = {
  /** Only requests of these subjects; all of them when left out. */
  readonly subjects?: readonly string[];
} & {
  [H in ApprovalHook]?: (
    event: ApprovalLifecycleEvent,
    tx: Transaction,
  ) => Promise<void>;
};
