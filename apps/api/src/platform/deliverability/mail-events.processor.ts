import { Injectable, Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { SystemContext } from '../../iam/access/system-context.js';
import { MAIL_INTAKE_JOB } from '../platform.jobs.js';
import { MAIL_EVENTS, type MailEventsJob } from './mail-event.types.js';
import { SuppressionsService } from './suppressions.service.js';

/**
 * Applies a provider's events to the suppression list, as the system
 * principal of the mail intake job (`system:mail-intake`, the actor of
 * the audit entries). One transaction per notification; a redelivered
 * notification records nothing (the events table's unique index).
 */
@Injectable()
@Processor(MAIL_EVENTS, { concurrency: 2 })
export class MailEventsProcessor extends WorkerHost {
  private readonly logger = new Logger('MailEvents');

  constructor(
    private readonly suppressions: SuppressionsService,
    private readonly system: SystemContext,
  ) {
    super();
  }

  async process(job: Job<MailEventsJob>) {
    const { provider, id, events } = job.data;
    // The deployment's: the suppression list is per address, every
    // tenant's mail together (docs/tenancy.md), so no tenant; its audit
    // entries are of no tenant either.
    const applied = await this.system.run(
      MAIL_INTAKE_JOB,
      (system) => this.suppressions.apply(system, provider, id, events),
      { tenantId: null },
    );
    if (applied.suppressed.length > 0) {
      this.logger.warn('Addresses suppressed', {
        provider,
        suppressed: applied.suppressed.length,
      });
    }
    return applied;
  }
}
