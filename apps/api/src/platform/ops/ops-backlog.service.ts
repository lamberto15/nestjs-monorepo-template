import { Injectable } from '@nestjs/common';
import { OutboxDeadLetters } from '@nestjs/outbox';
import type { Job, JobType } from 'bullmq';
import {
  and,
  count,
  eq,
  inArray,
  isNull,
  lt,
  ne,
  not,
  notInArray,
  or,
  sql,
} from 'drizzle-orm';
import type { Transaction } from '../../core/database/drizzle.js';
import { MAIL_QUEUE } from '../../core/mail/mail-queue.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { SystemContext } from '../../iam/access/system-context.js';
import { NotificationCatalog } from '../notifications/notification-catalog.js';
import { NOTIFICATIONS_TOPIC } from '../notifications/notification.types.js';
import { notifications } from '../notifications/notifications.tables.js';
import { OPS_BACKLOG_JOB } from '../platform.jobs.js';
import { OpsQueues } from './ops-queues.service.js';
import { outboxDeadLetters, outboxMessages } from './outbox-store.view.js';

/**
 * Which backlog an operator acts on. Exactly one of `tenantId` (that
 * tenant's) and `global` (every tenant's and the accounts' own): another
 * tenant's work is never touched by accident. `topic` and `type` narrow the
 * outbox (its topic, and a notification's type in the payload); `template`
 * narrows the `mail` queue (the mail class: the job's name); `before`
 * keeps to what was created before then.
 */
export interface BacklogScope {
  tenantId?: string;
  global?: boolean;
  topic?: string;
  type?: string;
  template?: string;
  before?: Date;
}

/** What a discard or a retry works on. */
export type BacklogTarget = 'outbox' | 'mail';

/** Rows per transaction, jobs per Redis page: no statement or reply grows with the backlog. */
export const BACKLOG_BATCH = 1_000;
/** The most a single call discards or retries (the default `limit`): call again while `more`. */
export const BACKLOG_LIMIT = 10_000;
/** Jobs a preview reads at most per queue state; past it the counts say `capped`. */
const MAX_SCAN = 250_000;
/** Mail that can be discarded: anything but running (BullMQ refuses to remove a locked job). */
const DISCARDABLE: JobType[] = ['waiting', 'prioritized', 'delayed', 'failed'];
/** Mail states a preview counts. */
const PREVIEWED: JobType[] = [...DISCARDABLE, 'active'];
/** Outbox groups a preview lists at most (largest first). */
const MAX_GROUPS = 100;

interface MailJobData {
  tenantId?: string | null;
  essential?: boolean;
  mandatory?: boolean;
}

/** Essential mail, or a mandatory notification's: never discarded. */
const kept = (job: Job) => {
  const data = job.data as MailJobData | undefined;
  return !!(data?.essential || data?.mandatory);
};

/** The outbox and dead-letter columns a scope reads. */
type OutboxColumns = Pick<
  typeof outboxMessages | typeof outboxDeadLetters,
  'topic' | 'payload' | 'createdAt'
>;

/** An outbox message no relay holds: never leased, or its lease ran out. */
const notLeased = (now: number) =>
  or(isNull(outboxMessages.leaseUntil), lt(outboxMessages.leaseUntil, now))!;

const typeOf = (columns: OutboxColumns) =>
  sql<string | null>`${columns.payload}->>'type'`;

/**
 * Scoped recovery of the two places a notification storm piles up
 * (docs/notifications.md, "Stopping a mail storm"): the PostgreSQL outbox
 * (pending messages and dead letters: deleting the BullMQ queue alone
 * leaves them to queue the mail again) and the BullMQ `mail` queue. A
 * preview counts first; a discard deletes, a retry runs again, each in
 * bounded batches and up to a limit per call. The callers (the operations
 * API, `pnpm ops backlog:*`) audit what they did.
 *
 * What is never discarded: a `mandatory` notification type's message (a
 * security notice), essential mail (`essential` on the job:
 * `@EssentialMail()` or a mandatory notification's), anything running
 * (an outbox message under a live lease, an active job). A discarded
 * `notifications.deliver` message marks its notification delivered: it
 * stays in the person's list, unread, with no push, mail or webhook.
 *
 * Each tenant's part runs as the system principal `system:ops-backlog`
 * in that tenant (docs/tenancy.md), so the notifications it marks are
 * only that tenant's.
 */
@Injectable()
export class OpsBacklog {
  constructor(
    private readonly system: SystemContext,
    private readonly tenancy: Tenancy,
    private readonly queues: OpsQueues,
    private readonly deadLetters: OutboxDeadLetters,
    private readonly catalog: NotificationCatalog,
  ) {}

  /** What a discard or a retry with this scope would touch, counted. */
  async preview(scope: BacklogScope) {
    const pending = new Map<string, OutboxGroup>();
    const dead = new Map<string, OutboxGroup>();
    let leased = 0;
    const mandatory = new Set(this.mandatoryTypes());
    for (const tenantId of await this.tenants(scope)) {
      await this.inTenant(tenantId, async (tx) => {
        const now = Date.now();
        const where = this.outboxWhere(outboxMessages, scope, tenantId, []);
        const rows = await tx
          .select({
            topic: outboxMessages.topic,
            type: typeOf(outboxMessages),
            count: count(),
          })
          .from(outboxMessages)
          .where(and(where, notLeased(now)))
          .groupBy(outboxMessages.topic, typeOf(outboxMessages));
        for (const row of rows) add(pending, row, mandatory);
        // Under a live lease: being delivered now, never discarded.
        const [inFlight] = await tx
          .select({ count: count() })
          .from(outboxMessages)
          .where(and(where, not(notLeased(now))));
        leased += inFlight?.count ?? 0;
        const letters = await tx
          .select({
            topic: outboxDeadLetters.topic,
            type: typeOf(outboxDeadLetters),
            count: count(),
          })
          .from(outboxDeadLetters)
          .where(this.outboxWhere(outboxDeadLetters, scope, tenantId, []))
          .groupBy(outboxDeadLetters.topic, typeOf(outboxDeadLetters));
        for (const row of letters) add(dead, row, mandatory);
      });
    }
    return {
      outbox: {
        pending: groups(pending),
        deadLetters: groups(dead),
        leased,
      },
      mail: await this.previewMail(scope),
    };
  }

  /**
   * Deletes up to `limit` of the backlog in scope, never what is
   * protected (above). `more`: the limit was reached, call again.
   */
  async discard(
    target: BacklogTarget,
    scope: BacklogScope,
    limit = BACKLOG_LIMIT,
  ) {
    if (target === 'mail') {
      return this.eachMailJob(scope, DISCARDABLE, limit, async (job) => {
        if (kept(job)) return false;
        return (await this.mailQueue().remove(job.id!)) === 1;
      });
    }
    const mandatory = this.mandatoryTypes();
    let done = 0;
    for (const tenantId of await this.tenants(scope)) {
      while (done < limit) {
        const size = Math.min(BACKLOG_BATCH, limit - done);
        const removed = await this.inTenant(tenantId, async (tx) => {
          const now = Date.now();
          const messages = await tx
            .delete(outboxMessages)
            .where(
              inArray(
                outboxMessages.id,
                tx
                  .select({ id: outboxMessages.id })
                  .from(outboxMessages)
                  .where(
                    and(
                      this.outboxWhere(
                        outboxMessages,
                        scope,
                        tenantId,
                        mandatory,
                      ),
                      notLeased(now),
                    ),
                  )
                  .limit(size),
              ),
            )
            .returning({
              topic: outboxMessages.topic,
              payload: outboxMessages.payload,
            });
          const letters =
            messages.length < size
              ? await tx
                  .select({
                    id: outboxDeadLetters.id,
                    topic: outboxDeadLetters.topic,
                    payload: outboxDeadLetters.payload,
                  })
                  .from(outboxDeadLetters)
                  .where(
                    this.outboxWhere(
                      outboxDeadLetters,
                      scope,
                      tenantId,
                      mandatory,
                    ),
                  )
                  .limit(size - messages.length)
              : [];
          if (letters.length > 0) {
            await this.deadLetters.purge(letters.map((letter) => letter.id));
          }
          await this.markDelivered(tx, [...messages, ...letters]);
          return messages.length + letters.length;
        });
        done += removed;
        if (removed < size) break;
      }
    }
    return { count: done, more: done >= limit };
  }

  /**
   * Runs the failed work in scope again, up to `limit`: the outbox's dead
   * letters (requeued with a fresh retry budget), or the `mail` queue's
   * failed jobs. The mail mode and the daily budgets still apply to what
   * a requeued notification queues.
   */
  async retry(
    target: BacklogTarget,
    scope: BacklogScope,
    limit = BACKLOG_LIMIT,
  ) {
    if (target === 'mail') {
      return this.eachMailJob(scope, ['failed'], limit, async (job) => {
        await job.retry('failed');
        return true;
      });
    }
    let done = 0;
    for (const tenantId of await this.tenants(scope)) {
      while (done < limit) {
        const size = Math.min(BACKLOG_BATCH, limit - done);
        const ids = await this.inTenant(tenantId, async (tx) =>
          (
            await tx
              .select({ id: outboxDeadLetters.id })
              .from(outboxDeadLetters)
              .where(this.outboxWhere(outboxDeadLetters, scope, tenantId, []))
              .orderBy(outboxDeadLetters.createdAt)
              .limit(size)
          ).map((row) => row.id),
        );
        const requeued = ids.length ? await this.deadLetters.requeue(ids) : 0;
        done += requeued;
        if (ids.length < size || requeued === 0) break;
      }
    }
    return { count: done, more: done >= limit };
  }

  private mailQueue() {
    return this.queues.queue(MAIL_QUEUE);
  }

  /** The tenant scopes to walk: one tenant, or the accounts' own (null) and every tenant. */
  private async tenants(scope: BacklogScope): Promise<(string | null)[]> {
    if (scope.global) {
      return [null, ...(await this.tenancy.all()).map((tenant) => tenant.id)];
    }
    if (!scope.tenantId) {
      throw new Error('A backlog scope names a tenant, or is global.');
    }
    return [scope.tenantId];
  }

  private inTenant<T>(
    tenantId: string | null,
    work: (tx: Transaction) => Promise<T>,
  ) {
    return this.system.run(OPS_BACKLOG_JOB, (_system, tx) => work(tx), {
      tenantId,
    });
  }

  private mandatoryTypes() {
    return this.catalog
      .declarations()
      .filter((declaration) => declaration.mandatory)
      .map((declaration) => declaration.type);
  }

  /**
   * The outbox rows of a scope in one tenant (the outbox has no row-level
   * security: the payload's `tenantId`, which every message carries).
   * `mandatory`: notification types left out (a discard's).
   */
  private outboxWhere(
    columns: OutboxColumns,
    scope: BacklogScope,
    tenantId: string | null,
    mandatory: string[],
  ) {
    const tenantOf = sql`${columns.payload}->>'tenantId'`;
    const type = typeOf(columns);
    return and(
      tenantId ? eq(tenantOf, tenantId) : isNull(tenantOf),
      scope.topic ? eq(columns.topic, scope.topic) : undefined,
      scope.type ? eq(type, scope.type) : undefined,
      scope.before ? lt(columns.createdAt, scope.before.getTime()) : undefined,
      mandatory.length > 0
        ? or(
            ne(columns.topic, NOTIFICATIONS_TOPIC),
            isNull(type),
            notInArray(type, mandatory),
          )
        : undefined,
    );
  }

  /** The notifications behind discarded deliveries: delivered (no push, mail or webhook), still in the list. */
  private async markDelivered(
    tx: Transaction,
    rows: { topic: string; payload: unknown }[],
  ) {
    const ids = rows
      .filter((row) => row.topic === NOTIFICATIONS_TOPIC)
      .map(
        (row) =>
          (row.payload as { notificationId?: unknown } | null)?.notificationId,
      )
      .filter((id): id is string => typeof id === 'string');
    if (ids.length === 0) return;
    await tx
      .update(notifications)
      .set({ deliveredAt: new Date(), digest: null, digestDueAt: null })
      .where(
        and(inArray(notifications.id, ids), isNull(notifications.deliveredAt)),
      );
  }

  /** Whether a mail job is in scope. One queued before mail carried its tenant matches a global scope only. */
  private mailMatches(job: Job | undefined, scope: BacklogScope) {
    if (!job?.id) return false;
    const data = job.data as MailJobData | undefined;
    if (!scope.global && data?.tenantId !== scope.tenantId) return false;
    if (scope.template && job.name !== scope.template) return false;
    if (scope.before && job.timestamp >= scope.before.getTime()) return false;
    return true;
  }

  /**
   * Walks the mail queue's jobs in `states`, a page at a time, handing
   * each one in scope to `act` (true: it left the list), up to `limit`.
   * The page start moves past what stayed, so jobs that left don't make
   * it skip others.
   */
  private async eachMailJob(
    scope: BacklogScope,
    states: JobType[],
    limit: number,
    act: (job: Job) => Promise<boolean>,
  ) {
    const queue = this.mailQueue();
    let done = 0;
    for (const state of states) {
      for (let start = 0; done < limit;) {
        const page = await queue.getJobs(
          [state],
          start,
          start + BACKLOG_BATCH - 1,
          true,
        );
        let left = 0;
        for (const job of page) {
          if (
            done < limit &&
            this.mailMatches(job, scope) &&
            (await act(job))
          ) {
            done++;
            left++;
          }
        }
        if (page.length < BACKLOG_BATCH) break;
        start += page.length - left;
      }
    }
    return { count: done, more: done >= limit };
  }

  /** The mail queue's jobs in scope by state and mail class, essential ones apart. */
  private async previewMail(scope: BacklogScope) {
    const queue = this.mailQueue();
    const found = new Map<string, MailGroup>();
    let capped = false;
    for (const state of PREVIEWED) {
      for (let start = 0; ; start += BACKLOG_BATCH) {
        if (start >= MAX_SCAN) {
          capped = true;
          break;
        }
        const page = await queue.getJobs(
          [state],
          start,
          start + BACKLOG_BATCH - 1,
          true,
        );
        for (const job of page) {
          if (!this.mailMatches(job, scope)) continue;
          const key = `${state}\u0000${job.name}`;
          const group = found.get(key) ?? {
            state,
            template: job.name,
            count: 0,
            essential: 0,
          };
          group.count++;
          if (kept(job)) group.essential++;
          found.set(key, group);
        }
        if (page.length < BACKLOG_BATCH) break;
      }
    }
    return {
      groups: [...found.values()].sort(
        (a, b) =>
          b.count - a.count ||
          a.state.localeCompare(b.state) ||
          a.template.localeCompare(b.template),
      ),
      capped,
    };
  }
}

export interface OutboxGroup {
  topic: string;
  type: string | null;
  count: number;
  /** A mandatory notification type's: never discarded. */
  mandatory: boolean;
}

export interface MailGroup {
  state: string;
  template: string;
  count: number;
  /** Of them, essential mail: never discarded. */
  essential: number;
}

function add(
  into: Map<string, OutboxGroup>,
  row: { topic: string; type: string | null; count: number },
  mandatory: Set<string>,
) {
  const key = `${row.topic}\u0000${row.type ?? ''}`;
  const group = into.get(key) ?? {
    topic: row.topic,
    type: row.type,
    count: 0,
    mandatory:
      row.topic === NOTIFICATIONS_TOPIC &&
      row.type !== null &&
      mandatory.has(row.type),
  };
  group.count += row.count;
  into.set(key, group);
}

const groups = (from: Map<string, OutboxGroup>) => {
  const all = [...from.values()].sort(
    (a, b) => b.count - a.count || a.topic.localeCompare(b.topic),
  );
  return {
    total: all.reduce((sum, group) => sum + group.count, 0),
    groups: all.slice(0, MAX_GROUPS),
  };
};
