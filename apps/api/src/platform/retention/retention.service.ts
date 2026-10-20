import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { Queue } from 'bullmq';
import { and, asc, eq, inArray, lt, sql } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import {
  database,
  type DrizzleTransactions,
  inTransaction,
} from '../../core/database/transactions.js';
import type { TenantEnvelope } from '../../core/tenancy/tenant-job.js';
import { currentTenantId } from '../../core/tenancy/tenant-scope.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import type { Principal, SystemPrincipal } from '../../iam/auth/principal.js';
import { notHeld } from '../../iam/holds/legal-holds.tables.js';
import { RecordPurgeRegistry } from '../../iam/resources/record-purge.registry.js';
import { RETENTION_JOB } from '../platform.jobs.js';
import type { RetentionRule } from './retention.registry.js';
import { RetentionRegistry } from './retention.registry.js';
import type { SetRetentionDto } from './retention.schemas.js';
import { retentionPolicies } from './retention.tables.js';

/** The retention queue (platform/queues/queues.ts). */
export const RETENTION = 'retention';

/** Rows purged or anonymised per job: short transactions, short locks. */
export const RETENTION_BATCH = 500;

const DAY = 86_400_000;

/** One batch of one rule in one tenant. */
export interface RetentionJob extends TenantEnvelope {
  /** The rule's name: `note`. */
  rule: string;
  /** Rows handled by the earlier batches of this run. */
  total?: number;
}

/** What one batch did. */
export interface RetentionBatch {
  /** Rows purged or anonymised. */
  count: number;
  /** Due rows left alone because of a legal hold (first batch only). */
  held?: number;
  /** Another batch is due. */
  more: boolean;
}

/**
 * Retention (roadmap item 5, docs/retention.md): the declared rules
 * (RetentionRegistry), each tenant's choice of days, and the work. The work
 * is heavy and destructive, so never in a request: the nightly
 * RetentionScheduler queues one job per tenant and enabled rule on the
 * `retention` queue, and each job handles one batch of RETENTION_BATCH rows
 * and queues the next.
 *
 * - **Legal holds win:** a held record is left out of the batch's SQL
 *   (`notHeld`), and checked again, locked, inside the batch's transaction.
 * - **Resumable:** a purged or anonymised row leaves the rule's condition, so
 *   a job that dies is retried and the next night finds what is left.
 * - **Audited:** each batch's transaction writes `retention.purged` or
 *   `retention.anonymised` (the rule, the ids, the days) as
 *   `system:retention`, in the tenant's log; a tenant's choice is
 *   `retention.policy-changed`.
 */
@Injectable()
export class RetentionService {
  private readonly logger = new Logger('Retention');

  /** The current transaction, or the database outside one (core/database/transactions.ts). */
  private get db() {
    return database(this.txHost);
  }

  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly registry: RetentionRegistry,
    private readonly purges: RecordPurgeRegistry,
    private readonly audit: AuditService,
    private readonly tenancy: Tenancy,
    @InjectQueue(RETENTION) private readonly queue: Queue<RetentionJob>,
  ) {}

  /** The declared rules with this tenant's choice for each. */
  async list() {
    const policies = await this.db.select().from(retentionPolicies);
    const byRule = new Map(policies.map((policy) => [policy.rule, policy]));
    return {
      items: this.registry.all().map((rule) => {
        const policy = byRule.get(rule.name);
        return {
          name: rule.name,
          label: rule.label,
          subject: rule.subject,
          action: rule.action,
          defaultDays: rule.defaultDays,
          minDays: rule.minDays ?? 1,
          enabled: policy?.enabled ?? false,
          days: policy?.days ?? rule.defaultDays,
          lastRunAt: policy?.lastRunAt?.toISOString() ?? null,
          lastCount: policy?.lastCount ?? null,
        };
      }),
    };
  }

  /** Turns a rule on or off for this tenant, and sets its days (not below the rule's minimum). */
  async set(
    principal: Principal,
    name: string,
    dto: SetRetentionDto,
    ip?: string,
  ) {
    const rule = this.registry.find(name);
    if (!rule) {
      throw new NotFoundException(`Retention rule "${name}" not found.`);
    }
    const minimum = rule.minDays ?? 1;
    if (dto.days !== undefined && dto.days < minimum) {
      throw new BadRequestException({
        code: 'validation_failed',
        message: 'The request is invalid.',
        errors: [
          {
            path: 'days',
            message: `${rule.label} are kept at least ${minimum} days.`,
          },
        ],
      });
    }
    await inTransaction(this.txHost, async (tx) => {
      const [before] = await tx
        .select()
        .from(retentionPolicies)
        .where(eq(retentionPolicies.rule, name));
      const days = dto.days ?? before?.days ?? rule.defaultDays;
      await tx
        .insert(retentionPolicies)
        .values({ rule: name, days, enabled: dto.enabled })
        .onConflictDoUpdate({
          target: [retentionPolicies.tenantId, retentionPolicies.rule],
          set: { days, enabled: dto.enabled },
        });
      await this.audit.record(
        principal,
        {
          action: 'retention.policy-changed',
          targetType: 'retentionRule',
          targetId: name,
          details: {
            from: before
              ? { enabled: before.enabled, days: before.days }
              : null,
            to: { enabled: dto.enabled, days },
          },
          ip,
        },
        tx,
      );
    });
    return (await this.list()).items.find((item) => item.name === name)!;
  }

  /**
   * Queues a first batch for every tenant's enabled rule: what the
   * scheduler runs. Returns how many jobs it queued.
   */
  async schedule(): Promise<number> {
    const perTenant = await this.tenancy.forEachTenant(
      RETENTION_JOB.key,
      async (tenant) => {
        const policies = await this.db
          .select({ rule: retentionPolicies.rule })
          .from(retentionPolicies)
          .where(eq(retentionPolicies.enabled, true));
        let queued = 0;
        for (const { rule } of policies) {
          if (!this.registry.find(rule)) {
            continue; // a rule no longer declared
          }
          await this.queue.add('batch', { tenantId: tenant.id, rule });
          queued++;
        }
        return queued;
      },
      // A deactivated tenant's old records still age out.
      { includeInactive: true },
    );
    let queued = 0;
    for (const count of perTenant.values()) {
      queued += count;
    }
    if (queued > 0) {
      this.logger.log(`Retention queued for ${queued} rule(s)`);
    }
    return queued;
  }

  /** Queues the next batch of a job's rule. */
  queueNext(job: RetentionJob, total: number) {
    return this.queue.add('batch', { ...job, total });
  }

  /**
   * One batch of `rule` in the current tenant, as `system`: the due rows
   * (older than the tenant's days, not held, still pending) purged or
   * anonymised in one transaction with their audit entry. Does nothing for
   * a rule the tenant has turned off since it was queued.
   */
  async batch(
    system: SystemPrincipal,
    rule: RetentionRule,
    first: boolean,
  ): Promise<RetentionBatch> {
    const [policy] = await this.db
      .select()
      .from(retentionPolicies)
      .where(eq(retentionPolicies.rule, rule.name));
    if (!policy?.enabled) {
      return { count: 0, more: false };
    }
    const cutoff = new Date(Date.now() - policy.days * DAY);
    const table: PgTable = rule.table;
    const id = rule.table.id;
    const due = and(
      lt(rule.ageColumn, cutoff),
      rule.where,
      rule.action === 'anonymise' ? rule.anonymise!.pending : undefined,
    );
    // Counted before the first batch only: how many due rows a hold keeps.
    const held = first
      ? await this.db
          .select({ count: sql<number>`count(*)::int` })
          .from(table)
          .where(and(due, sql`not ${notHeld(rule.subject, id)}`))
          .then((rows) => rows[0]?.count ?? 0)
      : undefined;
    const counted = await inTransaction(this.txHost, async (tx) => {
      // Locked, and checked for holds in the same statement.
      const rows = await tx
        .select({ id: sql<string>`${id}` })
        .from(table)
        .where(and(due, notHeld(rule.subject, id)))
        .orderBy(asc(id))
        .limit(RETENTION_BATCH)
        .for('update', { skipLocked: true });
      if (rows.length === 0) {
        return { count: 0, more: false };
      }
      const ids = rows.map((row) => row.id);
      if (rule.action === 'purge') {
        for (const listener of this.purges.of(rule.subject)) {
          await listener.forget(tx, rule.subject, ids);
        }
        await tx.delete(table).where(inArray(id, ids));
      } else {
        await tx
          .update(table)
          .set(rule.anonymise!.set as never)
          .where(inArray(id, ids));
      }
      await this.audit.record(
        system,
        {
          action:
            rule.action === 'purge'
              ? 'retention.purged'
              : 'retention.anonymised',
          targetType:
            rule.subject.charAt(0).toLowerCase() + rule.subject.slice(1),
          details: { rule: rule.name, ids, retentionDays: policy.days },
        },
        tx,
      );
      return { count: ids.length, more: ids.length === RETENTION_BATCH };
    });
    if ((held ?? 0) > 0) {
      this.logger.warn('Records kept by a legal hold', {
        rule: rule.name,
        tenant: currentTenantId(),
        held,
      });
    }
    return { ...counted, held };
  }

  /** Records a finished run on the tenant's policy. */
  async finish(rule: RetentionRule, total: number) {
    await this.db
      .update(retentionPolicies)
      .set({ lastRunAt: new Date(), lastCount: total })
      .where(eq(retentionPolicies.rule, rule.name));
  }
}
