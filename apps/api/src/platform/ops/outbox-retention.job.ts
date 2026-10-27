import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnOneInstance, WithoutOverlapping } from '@nestjs/locks';
import { OutboxDeadLetters, OutboxInbox } from '@nestjs/outbox';
import { Cron } from '@nestjs/schedule';
import { SystemContext } from '../../iam/access/system-context.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import { OUTBOX_RETENTION_JOB } from '../platform.jobs.js';
import type { PlatformEnv } from '../platform.env.js';

/**
 * Deletes outbox dead letters older than OUTBOX_DEAD_LETTER_RETENTION_DAYS
 * and consumers' inbox records older than OUTBOX_INBOX_RETENTION_DAYS, every
 * night at 04:20 in APP_TIMEZONE, on one instance. The package does the
 * deleting (`OutboxDeadLetters.purge()`, `OutboxInbox.prune()`); it never
 * ages either table out itself. The inbox is kept longer than the dead
 * letters (env.ts): a requeued dead letter keeps its id, and the inbox is
 * what recognizes it as a redelivery.
 *
 * The package's tables are global, one rule for every tenant: no tenant.
 */
@Injectable()
export class OutboxRetentionJob {
  private readonly logger = new Logger('Outbox');

  constructor(
    private readonly config: ConfigService<PlatformEnv, true>,
    private readonly system: SystemContext,
    private readonly audit: AuditService,
    private readonly deadLetters: OutboxDeadLetters,
    private readonly inbox: OutboxInbox,
  ) {}

  /** Returns how many dead letters and inbox records were deleted. */
  @Cron('20 4 * * *', {
    name: 'outbox-retention',
    timeZone: process.env.APP_TIMEZONE || 'UTC',
  })
  @OnOneInstance({ key: 'outbox:retention' })
  @WithoutOverlapping()
  run(now = new Date()) {
    return this.system.run(
      OUTBOX_RETENTION_JOB,
      async (system) => {
        const deadLetterDays = this.config.get(
          'OUTBOX_DEAD_LETTER_RETENTION_DAYS',
          { infer: true },
        );
        const inboxDays = this.config.get('OUTBOX_INBOX_RETENTION_DAYS', {
          infer: true,
        });
        const failedBefore = new Date(
          now.getTime() - deadLetterDays * 86_400_000,
        );
        const deadLetters = await this.deadLetters.purge({ failedBefore });
        if (deadLetters > 0) {
          await this.audit.record(system, {
            action: 'outbox.dead-letters-purged',
            details: {
              purged: deadLetters,
              failedBefore: failedBefore.toISOString(),
              days: deadLetterDays,
            },
          });
        }
        const inbox = await this.inbox.prune(`${inboxDays}d`);
        this.logger.log('Old outbox records deleted', {
          deadLetters,
          inbox,
          deadLetterDays,
          inboxDays,
        });
        return { deadLetters, inbox };
      },
      // Global tables (every tenant's messages together): no tenant.
      { transaction: false, tenantId: null },
    );
  }
}
