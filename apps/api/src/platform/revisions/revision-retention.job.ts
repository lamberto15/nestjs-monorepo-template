import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TransactionHost } from '@nestjs-cls/transactional';
import { OnOneInstance, WithoutOverlapping } from '@nestjs/locks';
import { Cron } from '@nestjs/schedule';
import { alias } from 'drizzle-orm/pg-core';
import { and, eq, exists, gt, lt } from 'drizzle-orm';
import {
  database,
  type DrizzleTransactions,
} from '../../core/database/transactions.js';
import type { PlatformEnv } from '../platform.env.js';
import { revisions } from './revisions.tables.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { SystemContext } from '../../iam/access/system-context.js';
import { REVISION_RETENTION_JOB } from '../platform.jobs.js';

const newer = alias(revisions, 'newer');

/**
 * Deletes revisions older than REVISIONS_RETENTION_DAYS, every night at
 * 03:25 in APP_TIMEZONE, on one instance; the latest revision of each
 * record always stays (it is the record's current state, and the next
 * change is diffed against it). A sweep of the whole table by age, the
 * same rule in every tenant: under the worker's row-level security bypass
 * (`Tenancy.bypass()`, docs/tenancy.md), "newer" compared within a tenant.
 */
@Injectable()
export class RevisionRetentionJob {
  private readonly logger = new Logger(RevisionRetentionJob.name);

  /** The current transaction, or the database outside one (core/database/transactions.ts). */
  private get db() {
    return database(this.txHost);
  }

  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly config: ConfigService<PlatformEnv, true>,
    private readonly system: SystemContext,
    private readonly tenancy: Tenancy,
  ) {}

  /** Returns how many revisions were deleted. */
  @Cron('25 3 * * *', {
    name: 'revisions-retention',
    timeZone: process.env.APP_TIMEZONE || 'UTC',
  })
  @OnOneInstance({ key: 'platform:revisions-retention' })
  @WithoutOverlapping()
  run(now = new Date()) {
    return this.system.run(
      REVISION_RETENTION_JOB,
      () =>
        this.tenancy.bypass(REVISION_RETENTION_JOB.key, async () => {
          const days = this.config.get('REVISIONS_RETENTION_DAYS', {
            infer: true,
          });
          const deleted = await this.db
            .delete(revisions)
            .where(
              and(
                lt(
                  revisions.changedAt,
                  new Date(now.getTime() - days * 86_400_000),
                ),
                // Not a record's latest: a newer revision of the same record exists.
                exists(
                  this.db
                    .select({ one: newer.id })
                    .from(newer)
                    .where(
                      and(
                        eq(newer.tenantId, revisions.tenantId),
                        eq(newer.subject, revisions.subject),
                        eq(newer.recordId, revisions.recordId),
                        gt(newer.number, revisions.number),
                      ),
                    ),
                ),
              ),
            )
            .returning({ id: revisions.id });
          this.logger.log('Old revisions deleted', {
            deleted: deleted.length,
            days,
          });
          return deleted.length;
        }),
      { transaction: false },
    );
  }
}
