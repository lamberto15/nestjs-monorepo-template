import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { type Job, UnrecoverableError } from 'bullmq';
import { SystemContext } from '../../iam/access/system-context.js';
import { RETENTION_JOB } from '../platform.jobs.js';
import { RetentionRegistry } from './retention.registry.js';
import {
  RETENTION,
  type RetentionJob,
  RetentionService,
} from './retention.service.js';

/**
 * Runs one batch of a retention rule (RetentionService.batch()) on the
 * workers, in the job's tenant, as `system:retention`, then queues the next
 * batch when there is one. One at a time per worker: background work that
 * may take its time.
 */
@Processor(RETENTION, { concurrency: 1 })
export class RetentionProcessor extends WorkerHost {
  private readonly logger = new Logger('Retention');

  constructor(
    private readonly retention: RetentionService,
    private readonly registry: RetentionRegistry,
    private readonly system: SystemContext,
  ) {
    super();
  }

  async process(job: Job<RetentionJob>) {
    const { tenantId, rule: name, total = 0 } = job.data;
    if (typeof tenantId !== 'string') {
      throw new UnrecoverableError(
        'A retention job carries the tenant it works for (docs/tenancy.md).',
      );
    }
    const rule = this.registry.find(name);
    if (!rule) {
      // A rule no longer declared: nothing to do, and retrying won't change that.
      this.logger.warn('Retention of a rule no longer declared', {
        rule: name,
      });
      return { count: 0, more: false };
    }
    const result = await this.system.run(
      RETENTION_JOB,
      (system) =>
        this.retention.batch(system, rule, job.data.total === undefined),
      { tenantId, transaction: false },
    );
    const done = total + result.count;
    if (result.more) {
      await this.retention.queueNext(job.data, done);
    } else {
      await this.system.run(
        RETENTION_JOB,
        () => this.retention.finish(rule, done),
        { tenantId, transaction: false },
      );
    }
    this.logger.log('Retention batch', {
      rule: name,
      tenant: tenantId,
      ...result,
    });
    return result;
  }
}
