import { Inject, Injectable, Logger } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import {
  database,
  type DrizzleTransactions,
  inTransaction,
} from '../../core/database/transactions.js';
import { ConfigService } from '@nestjs/config';
import { OnOneInstance, WithoutOverlapping } from '@nestjs/locks';
import { Cron } from '@nestjs/schedule';
import { and, inArray, lt } from 'drizzle-orm';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { SystemContext } from '../access/system-context.js';
import { AuditService } from '../audit/audit.service.js';
import type { IamEnv } from '../iam.env.js';
import { SOFT_DELETE_PURGE_JOB } from '../iam.jobs.js';
import { IAM_OPTIONS, type IamOptions } from '../iam.options.js';
import type { SystemPrincipal } from '../auth/principal.js';
import { notHeld } from '../holds/legal-holds.tables.js';
import { RecordPurgeRegistry } from './record-purge.registry.js';

/** Rows deleted per statement: short transactions, no long lock on a large table. */
const BATCH = 1000;

/**
 * Empties the recycle bins: deletes for good the records of soft-deletable
 * resources (`softDelete` on their resource) deleted longer ago than their
 * `retentionDays` (default SOFT_DELETE_RETENTION_DAYS). Every night at 03:45
 * in APP_TIMEZONE, on one instance, in batches. Foreign keys decide what
 * goes with them (cascade) as for any delete; the platform's
 * data about them (comments, tags, watchers, revisions: RecordPurgeRegistry)
 * goes in the same transaction, just before. It runs as the system
 * principal (`system:soft-delete-purge`), once per tenant in that tenant's
 * scope (`Tenancy.forEachTenant()`, docs/tenancy.md); a record under a legal
 * hold is skipped (`notHeld`): each batch's audit
 * entry (`records.purged`, the ids) commits with it, in that tenant's log.
 */
@Injectable()
export class SoftDeletePurgeJob {
  private readonly logger = new Logger(SoftDeletePurgeJob.name);

  /** The current transaction, or the database outside one (core/database/transactions.ts). */
  private get db() {
    return database(this.txHost);
  }

  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly config: ConfigService<IamEnv, true>,
    @Inject(IAM_OPTIONS) private readonly options: IamOptions,
    private readonly purges: RecordPurgeRegistry,
    private readonly system: SystemContext,
    private readonly audit: AuditService,
    private readonly tenancy: Tenancy,
  ) {}

  @Cron('45 3 * * *', {
    name: 'soft-delete-purge',
    timeZone: process.env.APP_TIMEZONE || 'UTC',
  })
  @OnOneInstance({ key: 'iam:soft-delete-purge' })
  @WithoutOverlapping()
  run() {
    return this.system.run(
      SOFT_DELETE_PURGE_JOB,
      async (system) => {
        const purged: Record<string, number> = {};
        const perTenant = await this.tenancy.forEachTenant(
          SOFT_DELETE_PURGE_JOB.key,
          (tenant) => this.purge(system, tenant.id),
          // Deactivated tenants' bins empty too: nobody restores from them.
          { includeInactive: true },
        );
        for (const counts of perTenant.values()) {
          for (const [subject, count] of Object.entries(counts)) {
            purged[subject] = (purged[subject] ?? 0) + count;
          }
        }
        this.logger.log('Recycle bins emptied', { purged });
        return purged;
      },
      // Short transactions, one per batch.
      { transaction: false },
    );
  }

  /** The current tenant's recycle bins. */
  private async purge(system: SystemPrincipal, tenantId: string) {
    const purged: Record<string, number> = {};
    for (const resource of this.options.resources ?? []) {
      if (!resource.softDelete) {
        continue;
      }
      const { table, retentionDays } = resource.softDelete;
      const days =
        retentionDays ??
        this.config.get('SOFT_DELETE_RETENTION_DAYS', { infer: true });
      const before = new Date(Date.now() - days * 86_400_000);
      let total = 0;
      for (;;) {
        const ids = await this.db
          .select({ id: table.id })
          .from(table)
          // A record under a legal hold stays in the bin (docs/retention.md).
          .where(
            and(
              lt(table.deletedAt, before),
              notHeld(resource.subject, table.id),
            ),
          )
          .limit(BATCH);
        if (!ids.length) {
          break;
        }
        const recordIds = ids.map((row) => row.id as string);
        await inTransaction(this.txHost, async (tx) => {
          for (const listener of this.purges.of(resource.subject)) {
            await listener.forget(tx, resource.subject, recordIds);
          }
          await tx.delete(table).where(inArray(table.id, recordIds));
          await this.audit.record(
            system,
            {
              action: 'records.purged',
              // As recordChange() names it: `note` for Note.
              targetType:
                resource.subject.charAt(0).toLowerCase() +
                resource.subject.slice(1),
              details: { ids: recordIds, retentionDays: days },
            },
            tx,
          );
        });
        total += ids.length;
      }
      purged[resource.subject] = total;
    }
    if (Object.values(purged).some((count) => count > 0)) {
      this.logger.log('Recycle bins emptied', { tenant: tenantId, purged });
    }
    return purged;
  }
}
