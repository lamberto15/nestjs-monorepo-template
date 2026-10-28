import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { getQueueToken } from '@nestjs/bullmq';
import type { JobType, Queue } from 'bullmq';
import { PLATFORM_OPTIONS, type PlatformOptions } from '../platform.options.js';
import { redactString } from '../../core/logging/redaction.js';
import { MAIL_QUEUE } from '../../core/mail/mail-queue.js';
import { SSO_QUEUE } from '../../iam/sso/sso.queue.js';
import { platformQueues } from '../queues/queues.js';

/** The states the metrics count jobs in. */
export const QUEUE_GAUGE_STATES = [
  'waiting',
  'active',
  'delayed',
  'failed',
] as const;

/** A tenant's jobs that can go: every state but `active` (BullMQ refuses to remove a locked job). */
const REMOVABLE_STATES: JobType[] = [
  'waiting',
  'delayed',
  'prioritized',
  'waiting-children',
  'completed',
  'failed',
];
/** Jobs read per page while looking for a tenant's. */
const JOBS_PAGE = 500;

/** The queues the features declared, for the operations API. */
@Injectable()
export class OpsQueues {
  constructor(
    @Inject(PLATFORM_OPTIONS) private readonly options: PlatformOptions,
    private readonly moduleRef: ModuleRef,
  ) {}

  /** The queues core, IAM (SSO) and the platform keep, and the features' own. */
  private get names() {
    return [MAIL_QUEUE, SSO_QUEUE, ...platformQueues(this.options.queues)];
  }

  /** A declared queue by name; 404 for another. */
  queue(name: string): Queue {
    if (!this.names.includes(name)) {
      throw new NotFoundException(`No queue named "${name}"`);
    }
    return this.moduleRef.get<Queue>(getQueueToken(name), { strict: false });
  }

  /** Pauses every queue (BullMQ `pause()`: jobs wait in Redis; running ones finish): the app mode. */
  async pauseAll() {
    await Promise.all(this.names.map((name) => this.queue(name).pause()));
  }

  /**
   * Pauses one queue for every process (BullMQ `pause()`, in Redis): its
   * jobs wait, running ones finish. An operator's stop for a storm
   * (`POST /v1/ops/queues/{name}/pause`, `pnpm ops queue:pause`).
   */
  async pause(name: string) {
    await this.queue(name).pause();
  }

  /** Resumes one queue (whether or not it was paused). */
  async resume(name: string) {
    await this.queue(name).resume();
  }

  /** Resumes the queues that are paused: the app mode's, and any an operator paused. */
  async resumeAll() {
    await Promise.all(
      this.names.map(async (name) => {
        const queue = this.queue(name);
        if (await queue.isPaused()) {
          await queue.resume();
        }
      }),
    );
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

  /**
   * The workers connected to each queue (BullMQ `getWorkersCount()`, Redis
   * `CLIENT LIST`): 0 everywhere means no worker process runs.
   */
  async workers() {
    return Promise.all(
      this.names.map(async (name) => ({
        name,
        workers: await this.queue(name).getWorkersCount(),
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
            id: job.id ?? null,
            name: job.name,
            attempts: job.attemptsMade,
            // The error's message, as BullMQ kept it: a secret in it (a
            // provider's URL, a token in an upstream reply) is masked as in the
            // logs, a stack trace's frames dropped, a long text cut.
            reason:
              typeof job.failedReason === 'string'
                ? redactString(job.failedReason)
                : null,
            failedAt: job.finishedOn
              ? new Date(job.finishedOn).toISOString()
              : null,
          })),
        };
      }),
    );
  }

  /**
   * Removes every job a tenant queued (its envelope's `tenantId`) from
   * every queue, in any state but running: waiting, delayed, finished
   * (their data is the tenant's too). A tenant's erase calls it
   * (TenantCleanup). One still running is refused with an error: the
   * erase waits for the next night rather than delete what it may still
   * write. BullMQ lists jobs by state, not by their data: each kept job is
   * read, the tenant's collected, then removed. Returns how many.
   */
  async removeTenantJobs(tenantId: string) {
    let removed = 0;
    for (const name of this.names) {
      const queue = this.queue(name);
      const ofTenant = (job: { data?: unknown } | undefined) =>
        !!job &&
        (job.data as { tenantId?: unknown } | null)?.tenantId === tenantId;
      const running = (await queue.getJobs(['active'])).filter(ofTenant);
      if (running.length > 0) {
        throw new Error(
          `${running.length} job(s) of tenant ${tenantId} still running in "${name}": erased on a later run.`,
        );
      }
      const found = [];
      // One state at a time: getJobs() pages each state's list by itself.
      for (const state of REMOVABLE_STATES) {
        for (let start = 0; ; start += JOBS_PAGE) {
          const page = await queue.getJobs(
            [state],
            start,
            start + JOBS_PAGE - 1,
            true,
          );
          found.push(...page.filter(ofTenant));
          if (page.length < JOBS_PAGE) {
            break;
          }
        }
      }
      for (const job of found) {
        await job.remove();
        removed++;
      }
    }
    return removed;
  }

  /** Puts the queue's failed jobs back to run again; returns how many. */
  async retryFailed(name: string) {
    const queue = this.queue(name);
    const failed = await queue.getFailedCount();
    await queue.retryJobs({ state: 'failed' });
    return failed;
  }
}
