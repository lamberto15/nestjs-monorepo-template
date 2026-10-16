import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnOneInstance, WithoutOverlapping } from '@nestjs/locks';
import { Cron } from '@nestjs/schedule';
import { lt } from 'drizzle-orm';
import { SystemContext } from '../access/system-context.js';
import type { IamEnv } from '../iam.env.js';
import { AUDIT_RETENTION_JOB } from '../iam.jobs.js';
import { auditLog } from '../iam.tables.js';
import { AuditService } from './audit.service.js';

/**
 * Deletes audit entries older than AUDIT_RETENTION_DAYS, every night at
 * 03:15 in APP_TIMEZONE, on one instance (@nestjs/locks), as the system
 * principal (`system:audit-retention`), which records what it deleted
 * (`audit.pruned`) in the same transaction. The example of a scheduled
 * job: copy its decorators, and its `system.run()`, for yours.
 */
@Injectable()
export class AuditRetentionJob {
  private readonly logger = new Logger(AuditRetentionJob.name);

  constructor(
    private readonly config: ConfigService<IamEnv, true>,
    private readonly system: SystemContext,
    private readonly audit: AuditService,
  ) {}

  @Cron('15 3 * * *', {
    name: 'audit-retention',
    timeZone: process.env.APP_TIMEZONE || 'UTC',
  })
  @OnOneInstance({ key: 'iam:audit-retention' })
  @WithoutOverlapping()
  async run() {
    const days = this.config.get('AUDIT_RETENTION_DAYS', { infer: true });
    const deleted = await this.system.run(
      AUDIT_RETENTION_JOB,
      async (system, tx) => {
        const before = new Date(Date.now() - days * 86_400_000);
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
      },
    );
    this.logger.log('Old audit entries deleted', { deleted, days });
    return deleted;
  }
}
