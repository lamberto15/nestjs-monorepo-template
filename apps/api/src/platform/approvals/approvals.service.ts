import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { I18nService } from '@nestjs/i18n';
import { TransactionHost } from '@nestjs-cls/transactional';
import { WorkflowClient } from '@nestjs/workflows';
import {
  and,
  asc,
  eq,
  getTableColumns,
  inArray,
  isNull,
  ne,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { Transaction } from '../../core/database/drizzle.js';
import {
  database,
  type DrizzleTransactions,
} from '../../core/database/transactions.js';
import { validationException } from '../../core/http/problem-details.filter.js';
import { etagOf } from '../../core/http/etag.js';
import type { ListQuery } from '../../core/http/list-query.js';
import {
  afterCursor,
  countPage,
  pageOffset,
  pageOrder,
  toPage,
} from '../../core/http/pagination.js';
import { AccessService } from '../../iam/access/access.service.js';
import {
  assertRequestPrincipal,
  principalKey,
  type Principal,
  type RequestPrincipal,
  type UserPrincipal,
} from '../../iam/auth/principal.js';
import { DELETED_USER_NAME } from '../../iam/auth/users.repository.js';
import {
  PersonalDataRegistry,
  type PersonalDataSource,
} from '../account/personal-data.registry.js';
import { users } from '../../iam/iam.tables.js';
import { RecordPurgeRegistry } from '../../iam/resources/record-purge.registry.js';
import { UserLifecycleRegistry } from '../../iam/auth/user-lifecycle.registry.js';
import { SettingsService } from '../settings/settings.service.js';
import {
  actorOf,
  AfterCommit,
  ApprovalEngine,
  requesterOf,
} from './approval-engine.service.js';
import {
  approvalWorkflowId,
  requestCancelled,
  requestResubmitted,
} from './approval-events.js';
import { type ApprovalList, participates } from './approval.list.js';
import { ApprovalPoliciesService } from './approval-policies.service.js';
import type {
  ApprovalDetail,
  ApprovalView,
  DecisionDto,
} from './approval.schemas.js';
import { approvalKey, type Requester } from './approval.types.js';
import { ApprovalWorkflow } from './approval.workflow.js';
import {
  approvalAssignments,
  approvalDelegations,
  approvalEvents,
  type ApprovalRequestRow,
  approvalRequests,
  OPEN_STATUSES,
} from './approvals.tables.js';
import { ApprovalsRegistry } from './approvals.registry.js';

/** What a feature asks for: this action on this record, with this proposed change. */
export interface ApprovalRequestInput {
  subject: string;
  recordId: string;
  action: string;
  /** The proposed change; left out (and refused) when the action reads it from the record (`payload()`). */
  payload?: Record<string, unknown>;
  /** The requester's note to the approvers. */
  comment?: string;
  /** Makes the call safe to retry (a workflow step's `idempotencyKey`): the same key, the same request. */
  idempotencyKey?: string;
}

/** `request()`'s answer: no approval needed (the policy is off, or its condition doesn't hold), or the request. */
export type ApprovalRequestResult =
  { required: false } | { required: true; request: ApprovalRequestRow };

type Decision = 'approved' | 'rejected' | 'changes_requested';

/** A workflow instance that may still apply an outcome: it runs, waits to retry, or undoes. */
const LIVE_WORKFLOW: readonly string[] = [
  'pending',
  'running',
  'suspended',
  'compensating',
];

/**
 * Approvals as features use them and people take part in them:
 * `request()` (the feature's service, when the action is asked for),
 * `pending()` and `assertNotPending()` (refuse edits meanwhile), and the
 * decisions, cancellation and resubmission of the API. Each change is one
 * transaction with its timeline, audit entry, notifications and webhooks;
 * the request's workflow (ApprovalWorkflow) takes it from there.
 */
@Injectable()
export class ApprovalsService implements PersonalDataSource {
  readonly name = 'approvals';

  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly registry: ApprovalsRegistry,
    private readonly engine: ApprovalEngine,
    private readonly policies: ApprovalPoliciesService,
    private readonly workflows: WorkflowClient,
    private readonly settings: SettingsService,
    private readonly access: AccessService,
    private readonly i18n: I18nService,
    purges: RecordPurgeRegistry,
    personalData: PersonalDataRegistry,
    lifecycle: UserLifecycleRegistry,
  ) {
    personalData.register(this);
    // A deactivated account decides nothing more: its pending assignments
    // close (their stages settle again), its delegations end. The actor is
    // the administrator who deactivated it, never the system.
    lifecycle.register({
      name: 'approvals',
      deactivated: (tx, userId, by) => this.engine.release(tx, userId, by),
    });
    // A record deleted for good takes its approval requests with it; the
    // open ones' workflows are told, so none waits for ever.
    purges.register({
      name: 'approvals',
      forget: async (tx, subject, recordIds) => {
        const open = await tx
          .select({
            id: approvalRequests.id,
            tenantId: approvalRequests.tenantId,
          })
          .from(approvalRequests)
          .where(
            and(
              eq(approvalRequests.subject, subject),
              inArray(approvalRequests.recordId, recordIds),
              inArray(approvalRequests.status, [...OPEN_STATUSES]),
            ),
          );
        for (const { id, tenantId } of open) {
          await this.workflows.signal(
            requestCancelled,
            { by: 'purge', tenantId },
            { key: id, id: `${id}:cancelled`, transaction: tx },
          );
        }
        await tx
          .delete(approvalRequests)
          .where(
            and(
              eq(approvalRequests.subject, subject),
              inArray(approvalRequests.recordId, recordIds),
            ),
          );
      },
    });
  }

  private get db() {
    return database(this.txHost);
  }

  /** A person's data export: the requests they made, and their decisions. */
  async *rows(user: UserPrincipal): AsyncGenerator<Record<string, unknown>[]> {
    const requests = await this.db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.requester, principalKey(user)))
      .orderBy(asc(approvalRequests.id));
    if (requests.length) {
      yield requests.map((row) => ({
        id: row.id,
        kind: 'request',
        subject: row.subject,
        recordId: row.recordId,
        action: row.action,
        status: row.status,
        title: row.title,
        comment: row.comment,
        createdAt: row.createdAt.toISOString(),
      }));
    }
    const decisions = await this.db
      .select()
      .from(approvalAssignments)
      .where(eq(approvalAssignments.decidedBy, user.id))
      .orderBy(asc(approvalAssignments.id));
    if (decisions.length) {
      yield decisions.map((row) => ({
        id: row.id,
        kind: 'decision',
        requestId: row.requestId,
        decision: row.status,
        comment: row.comment,
        onBehalfOf: row.onBehalfOf,
        decidedAt: row.decidedAt?.toISOString() ?? null,
      }));
    }
  }

  /**
   * An account's deletion: requests and decisions stay (others' records
   * depend on them), the names copied onto them go; their pending
   * assignments close and their stages are settled again; their
   * delegations end. Inside the account deletion job: it is the actor.
   */
  async erase(tx: Transaction, user: UserPrincipal) {
    await this.engine.release(tx, user.id, null);
    await tx
      .update(approvalRequests)
      .set({ requesterName: DELETED_USER_NAME })
      .where(eq(approvalRequests.requester, principalKey(user)));
    await tx
      .update(approvalAssignments)
      .set({ decidedByName: DELETED_USER_NAME })
      .where(eq(approvalAssignments.decidedBy, user.id));
    await tx
      .update(approvalEvents)
      .set({ actorName: DELETED_USER_NAME })
      .where(eq(approvalEvents.actor, principalKey(user)));
  }

  private problem(
    status: HttpStatus,
    code: string,
    key: Parameters<I18nService['translate']>[0],
    extra: Record<string, unknown> = {},
    args?: Record<string, unknown>,
  ) {
    return new HttpException(
      {
        code,
        message: this.i18n.translate(`approvals.${key}`, { args }),
        ...extra,
      },
      status,
    );
  }

  /** Nobody decides, withdraws, resubmits or delegates while acting as someone else (impersonation). */
  private assertNotImpersonating(principal: Principal) {
    if (principal.kind === 'user' && principal.impersonator) {
      throw new ForbiddenException({
        code: 'approval_impersonation',
        message: this.i18n.translate('auth.notWhileImpersonating'),
      });
    }
  }

  /**
   * The record's lock for approvals, in the transaction: `request()` and
   * resubmissions take it before they read the record's state (its
   * payload, its fingerprint), `assertNotPending()` before a write checks.
   * So a request and a change to the record take turns: a change waits for
   * the request (and is then refused), or a request waits for the change
   * (and then proposes it). An advisory lock: any subject, no row needed.
   */
  private async lockRecord(tx: Transaction, subject: string, recordId: string) {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`approval-record:${subject}:${recordId}`}))`,
    );
  }

  /** The payload of a request: the record's (the handler's `payload()`), else the caller's, checked. */
  private async payloadOf(
    handler: ReturnType<ApprovalsRegistry['action']>['handler'],
    declaration: ReturnType<ApprovalsRegistry['action']>['declaration'],
    recordId: string,
    given: Record<string, unknown> | undefined,
  ) {
    if (handler.payload && given !== undefined) {
      // What is approved is what the record holds, never what a caller says it holds.
      throw new BadRequestException({
        code: 'validation_failed',
        message: this.i18n.translate('approvals.payloadFromRecord'),
        errors: [
          {
            path: 'payload',
            message: this.i18n.translate('approvals.payloadFromRecord'),
          },
        ],
      });
    }
    const parsed = declaration.payload.safeParse(
      handler.payload ? await handler.payload(recordId) : given,
    );
    if (!parsed.success) {
      throw validationException(
        parsed.error.issues.map((issue) => ({
          ...issue,
          path: ['payload', ...issue.path],
        })),
      );
    }
    return parsed.data as Record<string, unknown>;
  }

  /**
   * Asks for approval of an action on a record. Answers `{ required: false }`
   * when none is needed (the policy is off, the feature's setting is off
   * for the requester, or the policy's `when` doesn't hold): the feature
   * then does the action itself. Otherwise the request is made (the
   * workflow starting in the same transaction) and its first stage's
   * approvers are assigned by the workflow; the action's handler runs on
   * the outcome. All of it under the record's lock (`lockRecord`). A 409
   * `approval_pending` when one is open for the same action on the record;
   * a 422 `approval_no_approvers` when a stage would find too few approvers.
   * `by` is the request's principal, or, from a job asking on someone's
   * behalf (the note publication workflow, for the owner), their key
   * `user:<id>` / `client:<id>`: the job is then the audit entry's actor,
   * the person the timeline's, so the job runs inside `SystemContext.run()`.
   */
  async request(
    by: RequestPrincipal | string,
    input: ApprovalRequestInput,
  ): Promise<ApprovalRequestResult> {
    if (typeof by !== 'string') {
      // The string form goes through requesterOf(): a request is never the system's.
      assertRequestPrincipal(by, 'An approval requester');
    }
    const key = approvalKey(input);
    const { declaration, handler } = this.registry.action(key);
    if (input.idempotencyKey) {
      const [existing] = await this.db
        .select()
        .from(approvalRequests)
        .where(eq(approvalRequests.idempotencyKey, input.idempotencyKey));
      if (existing) {
        return { required: true, request: existing };
      }
    }
    const requester: Requester =
      typeof by === 'string' ? requesterOf(by) : { kind: by.kind, id: by.id };
    const requesterKey = principalKey(requester);
    const { policy, version } = await this.policies.effective(key);
    if (!policy.enabled) {
      return { required: false };
    }
    if (
      declaration.setting &&
      !(await this.settings.get(declaration.setting, requester as Principal))
    ) {
      return { required: false };
    }
    const requesterName =
      typeof by === 'string'
        ? await this.engine.requesterName(requester)
        : by.name;
    const actor =
      typeof by === 'string'
        ? { key: requesterKey, name: requesterName }
        : actorOf(by);
    const result = await this.engine
      .run(async (tx): Promise<ApprovalRequestResult> => {
        await this.lockRecord(tx, input.subject, input.recordId);
        const payload = await this.payloadOf(
          handler,
          declaration,
          input.recordId,
          handler.payload ? undefined : input.payload,
        );
        const draft = {
          subject: input.subject,
          recordId: input.recordId,
          action: input.action,
          payload,
          requester: requesterKey,
        };
        const context = this.engine.context(draft);
        if (!(await this.registry.holds(policy.when, context))) {
          return { required: false };
        }
        await this.assertNoneOpen(input.subject, input.recordId, input.action);
        // Every stage must find enough approvers now; who exactly is decided when each starts.
        const startable = await this.engine.startable(context, policy);
        if (!startable.ok) {
          throw this.problem(
            HttpStatus.UNPROCESSABLE_ENTITY,
            'approval_no_approvers',
            'noApprovers',
            { stage: startable.stage },
            { stage: startable.stage },
          );
        }
        const described = await handler.describe(input.recordId, payload);
        const [created] = await tx
          .insert(approvalRequests)
          .values({
            ...draft,
            requesterName,
            title: described.title,
            link: described.link ?? null,
            policy,
            policyVersion: version,
            fingerprint: (await handler.fingerprint?.(input.recordId)) ?? null,
            comment: input.comment ?? null,
            idempotencyKey: input.idempotencyKey ?? null,
          })
          .returning();
        await this.engine.event(tx, created!, 'requested', actor, {
          policyVersion: version,
        });
        await this.engine.record(
          tx,
          typeof by === 'string' ? null : by,
          'approval.requested',
          created!,
          { policyVersion: version },
        );
        await this.engine.dispatch(tx, created!, 'approval.requested');
        await this.registry.emit('requested', { request: created!, actor }, tx);
        // The process exists if and only if the request does.
        await this.workflows.start(
          ApprovalWorkflow,
          { requestId: created!.id, tenantId: created!.tenantId },
          { id: approvalWorkflowId(created!.id), transaction: tx },
        );
        return { required: true, request: created! };
      })
      .catch((error: unknown) => {
        const code =
          (error as { code?: string })?.code ??
          (error as { cause?: { code?: string } })?.cause?.code;
        // Two requests at once: the open-request index lets one through.
        if (code === '23505') {
          throw this.pendingConflict();
        }
        throw error;
      });
    return result;
  }

  /** `approvalId`: the open request (the problem's own `requestId` is the HTTP request's). */
  private pendingConflict(approvalId?: string) {
    return this.problem(HttpStatus.CONFLICT, 'approval_pending', 'pending', {
      ...(approvalId && { approvalId }),
    });
  }

  private async assertNoneOpen(
    subject: string,
    recordId: string,
    action: string,
  ) {
    const [open] = await this.db
      .select({ id: approvalRequests.id })
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.subject, subject),
          eq(approvalRequests.recordId, recordId),
          eq(approvalRequests.action, action),
          inArray(approvalRequests.status, [...OPEN_STATUSES]),
        ),
      );
    if (open) {
      throw this.pendingConflict(open.id);
    }
  }

  /** The record's open requests (pending, or sent back for changes). */
  pending(subject: string, recordId: string) {
    return this.db
      .select()
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.subject, subject),
          eq(approvalRequests.recordId, recordId),
          inArray(approvalRequests.status, [...OPEN_STATUSES]),
        ),
      );
  }

  /**
   * For a feature's writes, in their transaction: a 409 `approval_pending`
   * while a request of the record (of this action, or any) waits for a
   * decision, or was approved and its outcome isn't applied yet, so what is
   * applied is what was approved. Takes the record's lock (`lockRecord`), so
   * a request being made waits for the write, or the write for the request.
   * Sent back for changes, the record may change.
   *
   * Call it inside the write's transaction: the lock lasts until it ends.
   * Outside one there is no lock to hold, so it throws (a programming
   * error, never a silent pass). While a request's own outcome handler runs
   * (`onApproved`…), that request lets the handler's writes through, so a
   * feature may apply the change through its normal, guarded write path.
   */
  async assertNotPending(subject: string, recordId: string, action?: string) {
    if (!this.txHost.isTransactionActive()) {
      throw new Error(
        `assertNotPending(${subject}, ${recordId}) ran outside a transaction: call it inside the write's inTransaction(), or the record's lock ends at once and protects nothing.`,
      );
    }
    const tx = database(this.txHost) as unknown as Transaction;
    await this.lockRecord(tx, subject, recordId);
    const applying = this.engine.applying();
    const [open] = await tx
      .select({ id: approvalRequests.id })
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.subject, subject),
          eq(approvalRequests.recordId, recordId),
          action ? eq(approvalRequests.action, action) : undefined,
          applying ? ne(approvalRequests.id, applying) : undefined,
          or(
            eq(approvalRequests.status, 'pending'),
            and(
              eq(approvalRequests.status, 'approved'),
              isNull(approvalRequests.outcomeAppliedAt),
            ),
          ),
        ),
      );
    if (open) {
      throw this.pendingConflict(open.id);
    }
  }

  /** Batch equivalent of assertNotPending: acquire all record locks in one statement, then inspect open requests once. */
  async assertNotPendingMany(subject: string, recordIds: readonly string[]) {
    if (!this.txHost.isTransactionActive()) {
      throw new Error(
        'assertNotPendingMany() must run inside the write transaction.',
      );
    }
    if (!recordIds.length) return;
    const tx = database(this.txHost) as unknown as Transaction;
    const ids = [...new Set(recordIds)];
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`approval-record:${subject}:`} || id::text)) from unnest(array[${sql.join(
        ids.map((id) => sql`${id}::uuid`),
        sql`, `,
      )}]) as ids(id)`,
    );
    const applying = this.engine.applying();
    const [open] = await tx
      .select({ id: approvalRequests.id })
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.subject, subject),
          inArray(approvalRequests.recordId, [...new Set(recordIds)]),
          applying ? ne(approvalRequests.id, applying) : undefined,
          or(
            eq(approvalRequests.status, 'pending'),
            and(
              eq(approvalRequests.status, 'approved'),
              isNull(approvalRequests.outcomeAppliedAt),
            ),
          ),
        ),
      );
    if (open) throw this.pendingConflict(open.id);
  }

  /**
   * For a feature deleting a record, in its transaction: the record's open
   * requests are cancelled (by `by`), so no approval acts on a record that
   * is gone. Their approvers are told; realtime events are left out (the
   * caller's transaction hasn't committed yet).
   */
  async withdraw(
    tx: Transaction,
    by: Principal,
    subject: string,
    recordId: string,
  ) {
    await this.lockRecord(tx, subject, recordId);
    const open = await tx
      .select({ id: approvalRequests.id })
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.subject, subject),
          eq(approvalRequests.recordId, recordId),
          inArray(approvalRequests.status, [...OPEN_STATUSES]),
        ),
      );
    for (const { id } of open) {
      const locked = (await this.engine.lock(tx, id))!;
      await this.engine.end(tx, new AfterCommit(), locked, 'cancelled', by, {
        reason: 'record_deleted',
      });
      await this.workflows.signal(
        requestCancelled,
        { by: principalKey(by), tenantId: locked.tenantId },
        { key: id, id: `${id}:cancelled`, transaction: tx },
      );
    }
    return open.length;
  }

  /** What the principal may read: what they take part in, or every request (of a subject) with Approval.read. */
  private async readable(principal: Principal): Promise<SQL | undefined> {
    const oversee = await this.access.sqlFilter(principal, 'Approval', 'read');
    return oversee === undefined
      ? undefined
      : sql`(${participates(principal)} or ${oversee})`;
  }

  /**
   * A page of the requests the caller may read, by the inbox's filters,
   * with `?fields=` applied: each item with the `can` and the `etag` its
   * `GET /approvals/{id}` would give the caller (`detailsOf()`, a handful
   * of queries for the whole page). Neither is a field `?fields=` removes.
   */
  async page(
    principal: Principal,
    query: ListQuery,
    list: Pick<ApprovalList, 'where' | 'pick'>,
  ) {
    const filter = and(await this.readable(principal), list.where(query));
    const [rows, total] = await Promise.all([
      this.db
        .select(getTableColumns(approvalRequests))
        .from(approvalRequests)
        .where(and(filter, afterCursor(approvalRequests.id, query)))
        .orderBy(...pageOrder(approvalRequests.id, query))
        .limit(query.limit + 1)
        .offset(pageOffset(query)),
      countPage(this.db, approvalRequests, filter, query),
    ]);
    const page = toPage(rows, query, total);
    const details = await this.detailsOf(principal, page.items);
    const picked = list.pick({ ...page, items: page.items.map(view) }, query);
    return {
      ...picked,
      items: picked.items.map((item, index) => ({
        ...item,
        can: details[index]!.can,
        // The tag GET /approvals/{id} sends: a decision's If-Match compares it.
        etag: etagOf(details[index]!),
      })),
    };
  }

  /** The request, if the principal may read it; a 404 otherwise (its existence stays hidden). */
  async find(principal: Principal, id: string, db = this.db) {
    const [row] = await db
      .select()
      .from(approvalRequests)
      .where(and(eq(approvalRequests.id, id), await this.readable(principal)));
    if (!row) {
      throw new NotFoundException();
    }
    return row;
  }

  /** The request with its stages, assignments, timeline and what the caller may do. */
  async detail(principal: Principal, id: string): Promise<ApprovalDetail> {
    return this.detailOf(principal, await this.find(principal, id));
  }

  private async detailOf(
    principal: Principal,
    row: ApprovalRequestRow,
  ): Promise<ApprovalDetail> {
    return (await this.detailsOf(principal, [row]))[0]!;
  }

  /**
   * The requests as `GET /approvals/{id}` shows them to the principal, in
   * their order: one request (the route, a decision's If-Match) or a page
   * of the inbox alike, in three queries whatever their number (their
   * assignments, their timelines, the principal's delegations); `can.cancel`
   * is the principal's ability, in memory.
   */
  private async detailsOf(
    principal: Principal,
    rows: readonly ApprovalRequestRow[],
  ): Promise<ApprovalDetail[]> {
    if (!rows.length) {
      return [];
    }
    const ids = rows.map((row) => row.id);
    const assignments = await this.db
      .select({
        ...getTableColumns(approvalAssignments),
        approverName: users.name,
      })
      .from(approvalAssignments)
      .leftJoin(users, eq(users.id, approvalAssignments.approverId))
      .where(inArray(approvalAssignments.requestId, ids))
      .orderBy(asc(approvalAssignments.id));
    const timeline = await this.db
      .select()
      .from(approvalEvents)
      .where(inArray(approvalEvents.requestId, ids))
      .orderBy(asc(approvalEvents.id));
    // Whom the principal stands in for now, of every subject or of one (held()'s rule).
    const delegations =
      principal.kind === 'user'
        ? await this.db
            .select({
              from: approvalDelegations.fromUserId,
              subject: approvalDelegations.subject,
            })
            .from(approvalDelegations)
            .where(
              and(
                eq(approvalDelegations.toUserId, principal.id),
                sql`${approvalDelegations.startsAt} <= now() and ${approvalDelegations.endsAt} > now()`,
              ),
            )
        : [];
    const details: ApprovalDetail[] = [];
    for (const row of rows) {
      details.push(
        await this.detailFrom(
          principal,
          row,
          assignments.filter((a) => a.requestId === row.id),
          timeline.filter((event) => event.requestId === row.id),
          new Set(
            delegations
              .filter((d) => d.subject === null || d.subject === row.subject)
              .map((d) => d.from),
          ),
        ),
      );
    }
    return details;
  }

  /** One request's detail, from its assignments, its timeline and whom the principal stands in for. */
  private async detailFrom(
    principal: Principal,
    row: ApprovalRequestRow,
    assignments: (typeof approvalAssignments.$inferSelect & {
      approverName: string | null;
    })[],
    timeline: (typeof approvalEvents.$inferSelect)[],
    delegators: ReadonlySet<string>,
  ): Promise<ApprovalDetail> {
    // held(): the current stage's assignments the principal decides, theirs or a delegator's.
    const decidable =
      row.status === 'pending' &&
      !row.stageOutcome &&
      principal.kind === 'user' &&
      row.requester !== principalKey(principal) &&
      assignments.some(
        (a) =>
          a.round === row.round &&
          a.stage === row.currentStage &&
          (a.approverId === principal.id || delegators.has(a.approverId)) &&
          a.status === 'pending',
      );
    const requester = row.requester === principalKey(principal);
    const open = (OPEN_STATUSES as readonly string[]).includes(row.status);
    return {
      ...view(row),
      stages: row.policy.stages.map((stage, index) => ({
        index,
        name: stage.name,
        mode: stage.mode,
        state:
          index < row.currentStage
            ? 'approved'
            : index > row.currentStage
              ? 'waiting'
              : row.status === 'pending'
                ? row.stageStartedAt
                  ? ((row.stageOutcome as 'approved' | null) ?? 'active')
                  : 'waiting'
                : row.status === 'approved' ||
                    row.status === 'rejected' ||
                    row.status === 'changes_requested'
                  ? row.status
                  : 'closed',
      })),
      assignments: assignments.map((assignment) => ({
        id: assignment.id,
        round: assignment.round,
        stage: assignment.stage,
        approverId: assignment.approverId,
        approverName: assignment.approverName ?? '',
        status: assignment.status,
        comment: assignment.comment,
        decidedAt: assignment.decidedAt?.toISOString() ?? null,
        decidedBy: assignment.decidedBy,
        decidedByName: assignment.decidedByName,
        onBehalfOf: assignment.onBehalfOf,
        escalated: assignment.escalated,
      })),
      timeline: timeline.map((event) => ({
        id: event.id,
        type: event.type,
        actor: event.actor,
        actorName: event.actorName,
        round: event.round,
        stage: event.stage,
        details: event.details,
        createdAt: event.createdAt.toISOString(),
      })),
      can: {
        decide: decidable,
        cancel:
          open &&
          (requester ||
            (await this.access.can(principal, 'cancel', 'Approval', {
              subject: row.subject,
            }))),
        resubmit: requester && row.status === 'changes_requested',
        // abandon() also refuses while the workflow still runs (409
        // approval_not_stuck): that is checked at call time, not here.
        abandon:
          row.status === 'approved' &&
          !row.outcomeAppliedAt &&
          (await this.access.can(principal, 'manage', 'Approval', {
            subject: row.subject,
          })),
      },
    };
  }

  /**
   * The assignments of the current stage the principal decides: their own,
   * and those of the people they stand in for now (an active delegation,
   * for every subject or this one). Pending or not.
   */
  private async held(
    principal: Principal,
    row: ApprovalRequestRow,
    db: typeof this.db | Transaction = this.db,
  ) {
    const stage = await db
      .select()
      .from(approvalAssignments)
      .where(
        and(
          eq(approvalAssignments.requestId, row.id),
          eq(approvalAssignments.round, row.round),
          eq(approvalAssignments.stage, row.currentStage),
        ),
      )
      .orderBy(asc(approvalAssignments.id));
    const delegators = new Set(
      (
        await db
          .select({ from: approvalDelegations.fromUserId })
          .from(approvalDelegations)
          .where(
            and(
              eq(approvalDelegations.toUserId, principal.id),
              sql`${approvalDelegations.startsAt} <= now() and ${approvalDelegations.endsAt} > now()`,
              sql`(${approvalDelegations.subject} is null or ${approvalDelegations.subject} = ${row.subject})`,
            ),
          )
      ).map((d) => d.from),
    );
    return stage.filter(
      (a) => a.approverId === principal.id || delegators.has(a.approverId),
    );
  }

  /**
   * An approver's decision. In the request's transaction, under its row
   * lock, so decisions take turns. One person, one decision per stage: it
   * applies to every assignment of the stage they hold or stand in for (as
   * a delegate, in the delegation's period), each recorded `onBehalfOf`
   * whoever it was assigned to. The stage's mode then says whether the
   * stage is decided (`settleStage`); once it is, its other approvers are
   * closed out (a late decision is a 409 `approval_already_decided`) and the
   * workflow is signalled. Deciding again the same way changes nothing.
   */
  async decide(
    principal: Principal,
    id: string,
    decision: Decision,
    dto: DecisionDto,
    ip?: string,
    /** The caller's If-Match check, run under the lock: the request as they would read it now. */
    unchanged?: (shown: ApprovalDetail) => void,
  ): Promise<ApprovalDetail> {
    this.assertNotImpersonating(principal);
    const row = await this.engine.run(async (tx, after) => {
      const locked = await this.engine.lock(tx, id);
      if (!locked) {
        throw new NotFoundException();
      }
      await this.find(principal, id, tx);
      unchanged?.(await this.detailOf(principal, locked));
      if (locked.requester === principalKey(principal)) {
        throw this.problem(
          HttpStatus.FORBIDDEN,
          'approval_self_approval',
          'selfApproval',
        );
      }
      if (locked.status !== 'pending') {
        throw this.problem(HttpStatus.CONFLICT, 'approval_closed', 'closed', {
          requestStatus: locked.status,
        });
      }
      const held =
        principal.kind === 'user' ? await this.held(principal, locked, tx) : [];
      if (!held.length) {
        throw this.problem(
          HttpStatus.FORBIDDEN,
          'approval_not_assignee',
          'notAssignee',
        );
      }
      const pending = held.filter((a) => a.status === 'pending');
      const mine = held.filter((a) => a.decidedBy === principal.id);
      if (mine.some((a) => a.status !== decision)) {
        throw this.problem(
          HttpStatus.CONFLICT,
          'approval_already_decided',
          'decidedOtherwise',
          { decision: mine.find((a) => a.status !== decision)!.status },
        );
      }
      if (!pending.length || locked.stageOutcome) {
        if (mine.length && !locked.stageOutcome) {
          return locked; // the same decision again: nothing changes
        }
        throw this.problem(
          HttpStatus.CONFLICT,
          'approval_already_decided',
          'alreadyDecided',
        );
      }
      const decided = await tx
        .update(approvalAssignments)
        .set({
          status: decision,
          comment: dto.comment ?? null,
          decidedAt: new Date(),
          decidedBy: principal.id,
          decidedByName: principal.name,
          onBehalfOf: sql`case when ${approvalAssignments.approverId} = ${principal.id} then null else ${approvalAssignments.approverId} end`,
        })
        .where(
          and(
            inArray(
              approvalAssignments.id,
              pending.map((a) => a.id),
            ),
            eq(approvalAssignments.status, 'pending'),
          ),
        )
        .returning();
      const actor = actorOf(principal);
      const stage = locked.currentStage;
      const onBehalfOf = decided
        .map((a) => a.onBehalfOf)
        .filter((who): who is string => !!who);
      await this.engine.event(
        tx,
        locked,
        'decided',
        actor,
        {
          decision,
          ...(dto.comment && { comment: dto.comment }),
          ...(onBehalfOf.length && { onBehalfOf }),
        },
        stage,
      );
      await this.engine.record(
        tx,
        principal,
        'approval.decided',
        locked,
        { decision, stage, ...(onBehalfOf.length && { onBehalfOf }) },
        ip,
      );
      await this.registry.emit(
        'decided',
        { request: locked, actor, stage, assignments: decided },
        tx,
      );
      return this.engine.settleStage(tx, after, locked, principal, {
        decision,
        comment: dto.comment,
        ip,
      });
    });
    return this.detailOf(principal, row);
  }

  /** The requester withdraws it, or someone who may cancel approvals (Approval.cancel). */
  async cancel(
    principal: Principal,
    id: string,
    reason?: string,
    ip?: string,
    unchanged?: (shown: ApprovalDetail) => void,
  ) {
    this.assertNotImpersonating(principal);
    const row = await this.engine.run(async (tx, after) => {
      const locked = await this.engine.lock(tx, id);
      if (!locked) {
        throw new NotFoundException();
      }
      await this.find(principal, id, tx);
      unchanged?.(await this.detailOf(principal, locked));
      if (
        locked.requester !== principalKey(principal) &&
        !(await this.access.can(principal, 'cancel', 'Approval', {
          subject: locked.subject,
        }))
      ) {
        throw new ForbiddenException({
          code: 'forbidden',
          message: this.i18n.translate('approvals.notRequester'),
        });
      }
      if (!(OPEN_STATUSES as readonly string[]).includes(locked.status)) {
        throw this.problem(HttpStatus.CONFLICT, 'approval_closed', 'closed', {
          requestStatus: locked.status,
        });
      }
      const ended = await this.engine.end(
        tx,
        after,
        locked,
        'cancelled',
        principal,
        { comment: reason, ip },
      );
      await this.workflows.signal(
        requestCancelled,
        { by: principalKey(principal), tenantId: locked.tenantId },
        { key: id, id: `${id}:cancelled`, transaction: tx },
      );
      return ended;
    });
    return this.detailOf(principal, row);
  }

  /**
   * After changes were requested, the requester sends it again: a new
   * round, from the first stage, its approvers resolved again. The request
   * keeps its policy version. Its status is checked first (409), then, under
   * the record's lock, its payload is the record's (`payload()`, a caller's
   * refused) or the one sent, and its fingerprint is taken again.
   */
  async resubmit(
    principal: Principal,
    id: string,
    dto: { payload?: Record<string, unknown>; comment?: string },
    ip?: string,
    unchanged?: (shown: ApprovalDetail) => void,
  ) {
    this.assertNotImpersonating(principal);
    const current = await this.find(principal, id);
    if (current.requester !== principalKey(principal)) {
      throw new ForbiddenException({
        code: 'forbidden',
        message: this.i18n.translate('approvals.notRequester'),
      });
    }
    const notSentBack = (status?: string) =>
      new ConflictException({
        code: 'approval_not_changes_requested',
        message: this.i18n.translate('approvals.notChangesRequested'),
        requestStatus: status,
      });
    if (current.status !== 'changes_requested') {
      throw notSentBack(current.status);
    }
    const { declaration, handler } = this.registry.action(approvalKey(current));
    const row = await this.engine.run(async (tx) => {
      // The record's lock first (as request() and the record's writes take it), then the request's.
      await this.lockRecord(tx, current.subject, current.recordId);
      const locked = await this.engine.lock(tx, id);
      if (locked) {
        unchanged?.(await this.detailOf(principal, locked));
      }
      if (!locked || locked.status !== 'changes_requested') {
        throw notSentBack(locked?.status);
      }
      const payload =
        dto.payload === undefined && !handler.payload
          ? locked.payload
          : await this.payloadOf(
              handler,
              declaration,
              locked.recordId,
              dto.payload,
            );
      const startable = await this.engine.startable(
        this.engine.context({ ...locked, payload }),
        locked.policy,
      );
      if (!startable.ok) {
        throw new UnprocessableEntityException({
          code: 'approval_no_approvers',
          message: this.i18n.translate('approvals.noApprovers', {
            args: { stage: startable.stage },
          }),
          stage: startable.stage,
        });
      }
      const described = await handler.describe(locked.recordId, payload);
      const [resubmitted] = await tx
        .update(approvalRequests)
        .set({
          status: 'pending',
          round: locked.round + 1,
          currentStage: 0,
          stageStartedAt: null,
          stageOutcome: null,
          dueAt: null,
          payload,
          title: described.title,
          link: described.link ?? null,
          fingerprint: (await handler.fingerprint?.(locked.recordId)) ?? null,
          // A new round: its outcome is still to be applied.
          outcomeAppliedAt: null,
          comment: dto.comment ?? locked.comment,
        })
        .where(eq(approvalRequests.id, id))
        .returning();
      const actor = actorOf(principal);
      await this.engine.event(tx, resubmitted!, 'resubmitted', actor, {
        ...(dto.comment && { comment: dto.comment }),
        payloadChanged:
          JSON.stringify(payload) !== JSON.stringify(locked.payload),
      });
      await this.engine.record(
        tx,
        principal,
        'approval.resubmitted',
        resubmitted!,
        { round: resubmitted!.round },
        ip,
      );
      await this.registry.emit(
        'resubmitted',
        { request: resubmitted!, actor },
        tx,
      );
      await this.workflows.signal(
        requestResubmitted,
        { round: resubmitted!.round, tenantId: resubmitted!.tenantId },
        {
          key: `${id}:${locked.round}`,
          id: `${id}:${locked.round}:resubmitted`,
          transaction: tx,
        },
      );
      return resubmitted!;
    });
    return this.detailOf(principal, row);
  }

  /**
   * An administrator (Approval.manage) gives up on an approved request whose
   * outcome will never apply: its workflow has ended without applying it
   * (failed, terminated, deleted). Only then: while the workflow runs or
   * retries, its handler may be applying the outcome right now (409
   * `approval_not_stuck`; it fails the request by itself, `apply_failed`,
   * when it gives up). The request ends as `failed` (`abandoned`): the
   * record is unlocked, the requester told, the listeners told, and, the
   * workflow being gone, `onFailed` runs here. Audited.
   */
  async abandon(
    principal: Principal,
    id: string,
    reason?: string,
    ip?: string,
    unchanged?: (shown: ApprovalDetail) => void,
  ) {
    this.assertNotImpersonating(principal);
    const row = await this.engine.run(async (tx, after) => {
      const locked = await this.engine.lock(tx, id);
      if (!locked) {
        throw new NotFoundException();
      }
      await this.find(principal, id, tx);
      unchanged?.(await this.detailOf(principal, locked));
      if (
        !(await this.access.can(principal, 'manage', 'Approval', {
          subject: locked.subject,
        }))
      ) {
        throw new ForbiddenException({
          code: 'forbidden',
          message: this.i18n.translate('approvals.notManager'),
        });
      }
      const instance = await this.workflows.getStatus(approvalWorkflowId(id));
      const live = instance && LIVE_WORKFLOW.includes(instance.status);
      if (locked.status !== 'approved' || locked.outcomeAppliedAt || live) {
        throw this.problem(
          HttpStatus.CONFLICT,
          'approval_not_stuck',
          'notStuck',
          {
            requestStatus: locked.status,
            ...(instance && { workflowStatus: instance.status }),
          },
        );
      }
      return this.engine.end(tx, after, locked, 'failed', principal, {
        reason: 'abandoned',
        comment: reason,
        ip,
      });
    });
    // Its workflow is gone: the failure's handler runs here (idempotent, as
    // every handler), as the administrator who gave up on it.
    await this.engine.conclude(
      id,
      'failed',
      `abandon:${id}`,
      row.round,
      principal,
    );
    return this.detailOf(principal, row);
  }
}

/** A request as lists show it. */
export function view(row: ApprovalRequestRow): ApprovalView {
  const stage = row.policy.stages[row.currentStage];
  return {
    id: row.id,
    key: approvalKey(row),
    subject: row.subject,
    recordId: row.recordId,
    action: row.action,
    status: row.status,
    requester: row.requester,
    requesterName: row.requesterName,
    title: row.title,
    link: row.link,
    payload: row.payload,
    policyVersion: row.policyVersion,
    round: row.round,
    currentStage: row.currentStage,
    stageCount: row.policy.stages.length,
    stageName: stage?.name ?? '',
    dueAt: row.dueAt?.toISOString() ?? null,
    comment: row.comment,
    outcomeReason: row.outcomeReason,
    endedAt: row.endedAt?.toISOString() ?? null,
    outcomeAppliedAt: row.outcomeAppliedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
