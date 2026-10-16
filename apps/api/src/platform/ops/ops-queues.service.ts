import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { PLATFORM_OPTIONS, type PlatformOptions } from '../platform.options.js';
import { redactText } from '../../core/logging/redaction.js';
import { MAIL_QUEUE } from '../../core/mail/mail-queue.js';
import { DATA_TRANSFERS } from '../data-transfer/data-transfer.service.js';
import { BULK } from '../bulk/bulk.service.js';

/** The states the metrics count jobs in. */
export const QUEUE_GAUGE_STATES = [
  'waiting',
  'active',
  'delayed',
  'failed',
] as const;

/** The queues the features declared, for the operations API. */
@Injectable()
export class OpsQueues {
  constructor(
    @Inject(PLATFORM_OPTIONS) private readonly options: PlatformOptions,
    private readonly moduleRef: ModuleRef,
  ) {}

  /** The queues the platform and core keep, and the features' own. */
  private get names() {
    return [MAIL_QUEUE, DATA_TRANSFERS, BULK, ...(this.options.queues ?? [])];
  }

  private queue(name: string): Queue {
    if (!this.names.includes(name)) {
      throw new NotFoundException(`No queue named "${name}"`);
    }
    return this.moduleRef.get<Queue>(getQueueToken(name), { strict: false });
  }

  /** Job counts by state per queue, without the failures (the metrics' scrape). */
  async counts() {
    return Promise.all(
      this.names.map(async (name) => ({
        name,
        counts: await this.queue(name).getJobCounts(...QUEUE_GAUGE_STATES),
      })),
    );
  }

  /** Job counts by state, and the latest failures, per queue. */
  async overview() {
    return Promise.all(
      this.names.map(async (name) => {
        const queue = this.queue(name);
        const [counts, failed, paused] = await Promise.all([
          queue.getJobCounts(
            'waiting',
            'active',
            'delayed',
            'completed',
            'failed',
          ),
          queue.getFailed(0, 9),
          queue.isPaused(),
        ]);
        return {
          name,
          paused,
          counts,
          recentFailures: failed.map((job) => ({
            id: job.id,
            name: job.name,
            attempts: job.attemptsMade,
            // The error's message, as BullMQ kept it: a secret in it (a
            // provider's URL, a token in an upstream reply) is masked as in the logs.
            reason:
              typeof job.failedReason === 'string'
                ? redactText(job.failedReason)
                : job.failedReason,
            failedAt: job.finishedOn
              ? new Date(job.finishedOn).toISOString()
              : null,
          })),
        };
      }),
    );
  }

  /** Puts the queue's failed jobs back to run again; returns how many. */
  async retryFailed(name: string) {
    const queue = this.queue(name);
    const failed = await queue.getFailedCount();
    await queue.retryJobs({ state: 'failed' });
    return failed;
  }
}
