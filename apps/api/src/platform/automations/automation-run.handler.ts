import { Injectable } from '@nestjs/common';
import { OnOutboxMessage, type OutboxHandlerContext } from '@nestjs/outbox';
import type { Transaction } from '../../core/database/drizzle.js';
import { inTenantOf } from '../../core/tenancy/tenant-job.js';
import { SystemContext } from '../../iam/access/system-context.js';
import { AUTOMATIONS_JOB } from '../platform.jobs.js';
import {
  AUTOMATIONS_TOPIC,
  type AutomationMessage,
  AutomationsService,
} from './automations.service.js';

/**
 * Runs a rule on a record's change, on a worker, once the write that
 * queued it committed (the outbox relay hands it over; `OutboxRelay.runOnce()`
 * in tests). In the message's tenant, as `system:automations` for what it
 * does itself (disabling a rule); the actions run as the rule's owner.
 */
@Injectable()
export class AutomationRunHandler {
  constructor(
    private readonly automations: AutomationsService,
    private readonly system: SystemContext,
  ) {}

  @OnOutboxMessage(AUTOMATIONS_TOPIC, { consumer: 'automations' })
  run(payload: AutomationMessage, ctx: OutboxHandlerContext<Transaction>) {
    return inTenantOf(payload, () =>
      this.system.run(
        AUTOMATIONS_JOB,
        (system) => this.automations.execute(payload, ctx, system),
        { transaction: false },
      ),
    );
  }
}
