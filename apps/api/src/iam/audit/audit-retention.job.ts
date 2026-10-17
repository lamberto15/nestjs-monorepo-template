import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnOneInstance, WithoutOverlapping } from '@nestjs/locks';
import { Cron } from '@nestjs/schedule';
import { lt } from 'drizzle-orm';
import { TransactionHost } from '@nestjs-cls/transactional';
import {
  type DrizzleTransactions,
  inTransaction,
} from '../../core/database/transactions.js';
import {
  Tenancy,
  TenantRunsFailed,
} from '../../core/tenancy/tenancy.service.js';
import { SystemContext } from '../access/system-context.js';
import type { SystemPrincipal } from '../auth/principal.js';
import type { IamEnv } from '../iam.env.js';
import { AUDIT_RETENTION_JOB } from '../iam.jobs.js';
import { auditLog } from '../iam.tables.js';
import { AuditService } from './audit.service.js';

/**
 * Deletes audit entries older than AUDIT_RETENTION_DAYS, every night at
 * 03:15 in APP_TIMEZONE, on one instance (@nestjs/locks), as the system
 * principal (`system:audit-retention`). Per tenant (docs/tenancy.md): each
 * tenant's log is pruned in that tenant's scope, and its own `audit.pruned`
 * entry (what was deleted) lands in that tenant's log, in the same
 * transaction; then once outside any tenant for the account-level entries
 * (sign-ins, sign-ups: no tenant), whose `audit.pruned` has none either.
 * Not the row-level security bypass: a whole-table delete would leave the
 * record of it in no tenant's log. The example of a scheduled job: copy
 * its decorators, and its `system.run()`, for yours.
 */
@Injectable()
export class AuditRetentionJob {
  private readonly logger = new Logger(AuditRetentionJob.name);

  constructor(
    private readonly config: ConfigService<IamEnv, true>,
    private readonly system: SystemContext,
    private readonly audit: AuditService,
    private readonly tenancy: Tenancy,
    private readonly txHost: TransactionHost<DrizzleTransactions>,
  ) {}

  @Cron('15 3 * * *', {
    name: 'audit-retention',
    timeZone: process.env.APP_TIMEZONE || 'UTC',
  })
  @OnOneInstance({ key: 'iam:audit-retention' })
  @WithoutOverlapping()
  async run() {
    const days = this.config.get('AUDIT_RETENTION_DAYS', { infer: true });
    const before = new Date(Date.now() - days * 86_400_000);
    const deleted = await this.system.run(
      AUDIT_RETENTION_JOB,
      async (system) => {
        let total = 0;
        // Every tenant, deactivated ones too (their entries age out as
        // well); a tenant's failure doesn't stop the others nor the
        // account-level pass, and is reported after it.
        const { results: perTenant, failures } = await this.tenancy.settle(
          AUDIT_RETENTION_JOB.key,
          async (tenant) => {
            const count = await this.prune(system, before, days);
            if (count > 0) {
              this.logger.log('Old audit entries deleted', {
                tenant: tenant.id,
                deleted: count,
                days,
              });
            }
            return count;
          },
          { includeInactive: true },
        );
        for (const count of perTenant.values()) {
          total += count;
        }
        // The account-level entries, outside any tenant.
        total += await this.system.run(
          AUDIT_RETENTION_JOB,
          () => this.prune(system, before, days),
          { transaction: false, tenantId: null },
        );
        if (failures.length > 0) {
          throw new TenantRunsFailed(AUDIT_RETENTION_JOB.key, failures);
        }
        return total;
      },
      { transaction: false },
    );
    this.logger.log('Old audit entries deleted', { deleted, days });
    return deleted;
  }

  /** One transaction in the current scope: the old entries, and the record of their deletion. */
  private prune(system: SystemPrincipal, before: Date, days: number) {
    return inTransaction(this.txHost, async (tx) => {
      const rows = await tx
        .delete(auditLog)
        .where(lt(auditLog.at, before))
        .returning({ id: auditLog.id });
      if (rows.length > 0) {
        // Who removed history, and how much: an entry of its own, never itself pruned this run.
        await this.audit.record(
          system,
          {
            action: 'audit.pruned',
            details: {
              deleted: rows.length,
              days,
              before: before.toISOString(),
            },
          },
          tx,
        );
      }
      return rows.length;
    });
  }
}
