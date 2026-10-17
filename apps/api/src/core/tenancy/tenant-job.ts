import { WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { ClsServiceManager } from 'nestjs-cls';
import {
  assertUuid,
  NO_TENANT,
  requireTenantId,
  TENANT_SCOPE,
  tenantScope,
} from './tenant-scope.js';

/**
 * What every asynchronous hand-over carries (docs/tenancy.md, "Async"):
 * queue jobs' data, outbox payloads, workflow inputs and signals. A type,
 * not a convention: `tenantId` is required, so a producer that forgets it
 * doesn't compile, and the consumer restores it before any query
 * (`inTenantOf()`, `TenantWorkerHost`). `null` only where the work is an
 * account's own, outside any tenant (a security notification).
 */
export interface TenantEnvelope {
  readonly tenantId: string | null;
}

/** The data with the current context's tenant (a TenantScopeMissingError without one). */
export function withTenant<T extends object>(
  data: T,
): T & { tenantId: string } {
  return {
    ...data,
    tenantId: requireTenantId('A job, an event or a workflow'),
  };
}

/**
 * Runs `work` in the tenant an envelope names, in a CLS context of its own:
 * what a consumer does first. An envelope without the field (a job queued
 * before tenancy, a hand-made payload) is refused rather than run with no
 * tenant: its work could only fail later, or worse, run in the wrong one.
 */
export function inTenantOf<T>(
  envelope: Partial<TenantEnvelope> | undefined | null,
  work: () => Promise<T>,
): Promise<T> {
  const tenantId = envelope?.tenantId;
  if (tenantId === undefined) {
    return Promise.reject(
      new Error(
        'The payload carries no tenantId: every job, outbox event and workflow input names its tenant (docs/tenancy.md).',
      ),
    );
  }
  const scope =
    tenantId === null ? NO_TENANT : tenantScope(assertUuid(tenantId));
  const cls = ClsServiceManager.getClsService();
  // Awaited inside: a query builder runs when awaited, in this context.
  return cls.run({ ifNested: 'inherit' }, async () => {
    cls.set(TENANT_SCOPE, scope);
    return await work();
  });
}

/**
 * A BullMQ processor whose jobs carry their tenant (`TenantEnvelope`):
 * `process()` restores it, then calls `handle()`, so every query of the
 * job runs in the tenant that queued it. Producers queue
 * `withTenant(data)`.
 *
 * ```ts
 * @Processor('thumbnails')
 * export class ThumbnailProcessor extends TenantWorkerHost<{ fileKey: string }> {
 *   async handle(job: Job<{ fileKey: string } & TenantEnvelope>) { … }
 * }
 * ```
 */
export abstract class TenantWorkerHost<
  T extends object = object,
  R = unknown,
> extends WorkerHost {
  override process(job: Job<T & TenantEnvelope>, token?: string): Promise<R> {
    return inTenantOf(job.data, () => this.handle(job, token));
  }

  abstract handle(job: Job<T & TenantEnvelope>, token?: string): Promise<R>;
}
