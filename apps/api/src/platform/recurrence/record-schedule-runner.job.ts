import { Injectable, Logger } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { OnOneInstance, WithoutOverlapping } from '@nestjs/locks';
import { Cron } from '@nestjs/schedule';
import { and, asc, eq, lte } from 'drizzle-orm';
import {
  database,
  type DrizzleTransactions,
} from '../../core/database/transactions.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { SystemContext } from '../../iam/access/system-context.js';
import { RECORD_SCHEDULE_JOB } from '../platform.jobs.js';
import { RecordSchedulesService } from './record-schedules.service.js';
import { recordSchedules } from './record-schedules.tables.js';

/** At most this many schedules are looked at in one pass; the rest wait for the next. */
const BATCH = 500;
/** At most this many occurrences of one schedule are made in one pass (making up missed ones). */
export const MAX_PER_PASS = 10;

/**
 * Creates the records of the recurring schedules that are due, every five
 * minutes, on one instance (and, should two ever run, the schedule row's
 * lock and the unique run per occurrence still keep a record from being
 * made twice: `RecordSchedulesService.runDue()`). A schedule behind
 * (downtime) is made up oldest first, `MAX_PER_PASS` at a time. One tenant
 * at a time (`Tenancy.forEachTenant()`); each record is created as the
 * schedule's owner, the runner being the system principal
 * (`system:record-schedules`) that audits what it does itself.
 * `run(now)` lets a test choose the moment; it returns how many records
 * were created.
 */
@Injectable()
export class RecordScheduleRunnerJob {
  private readonly logger = new Logger('RecordSchedules');

  /** The current transaction, or the database outside one (core/database/transactions.ts). */
  private get db() {
    return database(this.txHost);
  }

  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly schedules: RecordSchedulesService,
    private readonly system: SystemContext,
    private readonly tenancy: Tenancy,
  ) {}

  @Cron('*/5 * * * *', {
    name: 'record-schedule-runner',
    timeZone: process.env.APP_TIMEZONE || 'UTC',
  })
  @OnOneInstance({ key: 'platform:record-schedule-runner' })
  @WithoutOverlapping()
  async run(now = new Date()) {
    const created = await this.tenancy.forEachTenant(
      RECORD_SCHEDULE_JOB.key,
      () => this.runTenant(now),
    );
    return [...created.values()].reduce((sum, count) => sum + count, 0);
  }

  /** The due schedules of the current tenant. */
  private runTenant(now: Date) {
    return this.system.run(
      RECORD_SCHEDULE_JOB,
      async (system) => {
        const due = await this.db
          .select({ id: recordSchedules.id })
          .from(recordSchedules)
          .where(
            and(
              eq(recordSchedules.status, 'active'),
              lte(recordSchedules.nextRunAt, now),
            ),
          )
          .orderBy(asc(recordSchedules.nextRunAt))
          .limit(BATCH);
        let created = 0;
        for (const { id } of due) {
          for (let made = 0; made < MAX_PER_PASS; made++) {
            const outcome = await this.schedules.runDue(id, now, system);
            if (outcome === 'created') created++;
            // Failed, or nothing due (any more): the next pass.
            if (outcome !== 'created' && outcome !== 'skipped') break;
          }
        }
        this.logger.log('Recurring records created', {
          tenant: this.tenancy.tenantId(),
          due: due.length,
          created,
        });
        return created;
      },
      { transaction: false },
    );
  }
}
