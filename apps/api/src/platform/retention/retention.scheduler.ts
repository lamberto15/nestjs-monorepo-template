import { Injectable } from '@nestjs/common';
import { OnOneInstance, WithoutOverlapping } from '@nestjs/locks';
import { Cron } from '@nestjs/schedule';
import { SystemContext } from '../../iam/access/system-context.js';
import { RETENTION_JOB } from '../platform.jobs.js';
import { RetentionRegistry } from './retention.registry.js';
import { RetentionService } from './retention.service.js';

/**
 * Every night at 04:10 in APP_TIMEZONE, on one instance: queues the
 * retention work of every tenant's enabled rules (RetentionService.schedule()).
 * The deletions themselves run on the queue, never here. Nothing to do (and
 * no query) while no rule is declared.
 */
@Injectable()
export class RetentionScheduler {
  constructor(
    private readonly retention: RetentionService,
    private readonly registry: RetentionRegistry,
    private readonly system: SystemContext,
  ) {}

  /** Returns how many jobs it queued. */
  @Cron('10 4 * * *', {
    name: 'retention',
    timeZone: process.env.APP_TIMEZONE || 'UTC',
  })
  @OnOneInstance({ key: 'platform:retention' })
  @WithoutOverlapping()
  run() {
    if (this.registry.all().length === 0) {
      return Promise.resolve(0);
    }
    return this.system.run(RETENTION_JOB, () => this.retention.schedule(), {
      // forEachTenant() gives each tenant its own scope.
      transaction: false,
    });
  }
}
