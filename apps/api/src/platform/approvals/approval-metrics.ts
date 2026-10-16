import { Injectable, type OnModuleInit } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  database,
  type DrizzleTransactions,
} from '../../core/database/transactions.js';
import { MetricsService } from '../../core/metrics/metrics.service.js';
import { approvalRequests, OPEN_STATUSES } from './approvals.tables.js';

/**
 * Approvals on core's `/metrics`: the open requests, and how far the most
 * overdue pending stage is past its deadline. A stage past its deadline is
 * escalated or expired by its workflow within a poll, so a value that
 * stays means the workflows' timers aren't running (the ApprovalsOverdue
 * alert, monitoring/prometheus/alerts.yml). Shared state: every instance
 * reports the same, aggregate with max().
 */
@Injectable()
export class ApprovalMetrics implements OnModuleInit {
  constructor(
    private readonly metrics: MetricsService,
    private readonly txHost: TransactionHost<DrizzleTransactions>,
  ) {}

  /** One query per scrape for both gauges. */
  private pending?: Promise<{
    open: Record<string, number>;
    overdue: number;
    unapplied: number;
  }>;

  private read() {
    this.pending ??= this.query().finally(() => {
      setImmediate(() => (this.pending = undefined));
    });
    return this.pending;
  }

  private async query() {
    const rows = await database(this.txHost)
      .select({
        status: approvalRequests.status,
        count: sql<number>`count(*)::int`,
        overdue: sql<number>`coalesce(max(extract(epoch from now() - ${approvalRequests.dueAt})) filter (where ${approvalRequests.dueAt} < now()), 0)::float8`,
      })
      .from(approvalRequests)
      .where(inArray(approvalRequests.status, [...OPEN_STATUSES]))
      .groupBy(approvalRequests.status);
    const open = Object.fromEntries(rows.map((row) => [row.status, row.count]));
    const overdue = rows.find((row) => row.status === 'pending')?.overdue ?? 0;
    // Approved, its outcome not applied yet: the workflow applies it within
    // minutes, or fails it (apply_failed); one that stays is stuck.
    const [unapplied] = await database(this.txHost)
      .select({
        seconds: sql<number>`coalesce(max(extract(epoch from now() - ${approvalRequests.endedAt})), 0)::float8`,
      })
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.status, 'approved'),
          isNull(approvalRequests.outcomeAppliedAt),
        ),
      );
    return { open, overdue, unapplied: unapplied?.seconds ?? 0 };
  }

  onModuleInit() {
    this.metrics.collect(
      'approvals_open',
      'Approval requests waiting: pending (on approvers), changes_requested (on the requester).',
      async () => {
        const { open } = await this.read();
        return OPEN_STATUSES.map((status) => ({
          labels: { status },
          value: open[status] ?? 0,
        }));
      },
      ['status'],
    );
    this.metrics.collect(
      'approvals_overdue_seconds',
      'How far the most overdue pending approval stage is past its deadline (0: none).',
      async () => [{ value: (await this.read()).overdue }],
    );
    this.metrics.collect(
      'approvals_unapplied_seconds',
      'How long the oldest approved request has waited for its outcome to be applied (0: none).',
      async () => [{ value: (await this.read()).unapplied }],
    );
  }
}
