import { Injectable, Logger } from '@nestjs/common';
import { OutboxDeadLetters } from '@nestjs/outbox';
import { StorageDisk } from '@nestjs/storage';
import { WorkflowClient, WorkflowNotFoundError } from '@nestjs/workflows';
import { TransactionHost } from '@nestjs-cls/transactional';
import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import {
  database,
  type DrizzleTransactions,
} from '../../core/database/transactions.js';
import { TenantLifecycleRegistry } from '../../iam/access/tenant-lifecycle.registry.js';
import { OpsQueues } from '../ops/ops-queues.service.js';
import { outboxMessages } from '../ops/outbox-store.view.js';
import { tenantFileKey } from '../storage/storage.config.js';

/** Instances, dead letters and files read per page while looking for a tenant's. */
const PAGE = 100;
/** Files deleted per call. */
const DELETE_BATCH = 500;

/** Whether a payload (a job's data, a workflow's input, a message) names this tenant. */
const ofTenant = (payload: unknown, tenantId: string) =>
  typeof payload === 'object' &&
  payload !== null &&
  (payload as { tenantId?: unknown }).tenantId === tenantId;

/**
 * What a tenant's erase removes besides its rows (docs/tenancy.md,
 * "Deleting a tenant"), as TenantLifecycleRegistry listeners
 * (`beforeErase`, run by TenantDeletionJob in a worker before the
 * tenant's row goes), in this order: its queued jobs (none left to write
 * a file after the files went), its workflow instances, its outbox
 * messages, then its stored files. Each finds the tenant by the envelope
 * every hand-over carries (`tenantId`, TenantEnvelope) or by its files'
 * prefix (`tenants/<id>/`), and can run again: a failure stops the erase,
 * which the next night starts over.
 */
@Injectable()
export class TenantCleanup {
  private readonly logger = new Logger(TenantCleanup.name);

  constructor(
    lifecycle: TenantLifecycleRegistry,
    private readonly queues: OpsQueues,
    private readonly workflows: WorkflowClient,
    private readonly deadLetters: OutboxDeadLetters,
    private readonly disk: StorageDisk,
    private readonly txHost: TransactionHost<DrizzleTransactions>,
  ) {
    lifecycle.register({
      name: 'queues',
      beforeErase: async (tenantId) => {
        const removed = await this.queues.removeTenantJobs(tenantId);
        this.logger.log('A tenant’s jobs removed', { tenantId, removed });
      },
    });
    lifecycle.register({
      name: 'workflows',
      beforeErase: (tenantId) => this.removeWorkflows(tenantId),
    });
    lifecycle.register({
      name: 'outbox',
      beforeErase: (tenantId) => this.removeMessages(tenantId),
    });
    lifecycle.register({
      name: 'storage',
      beforeErase: (tenantId) => this.removeFiles(tenantId),
    });
  }

  /**
   * Every workflow instance whose input names the tenant, finished or not,
   * deleted without its compensations (`force`: they would act on the
   * tenant's rows, which are going). The package lists instances by
   * status and workflow, not by input: every instance is read (finished
   * ones are purged by age, so the table stays small).
   */
  async removeWorkflows(tenantId: string) {
    const ids: string[] = [];
    for (let offset = 0; ; offset += PAGE) {
      const page = await this.workflows.list({ limit: PAGE, offset });
      ids.push(
        ...page
          .filter((instance) => ofTenant(instance.input, tenantId))
          .map((instance) => instance.id),
      );
      if (page.length < PAGE) {
        break;
      }
    }
    for (const id of ids) {
      try {
        await this.workflows.delete(id, { force: true });
      } catch (error) {
        // Gone already (a parent's deletion, an earlier run): what was wanted.
        if (!(error instanceof WorkflowNotFoundError)) {
          throw error;
        }
      }
    }
    this.logger.log('A tenant’s workflows removed', {
      tenantId,
      removed: ids.length,
    });
  }

  /**
   * The tenant's outbox messages not yet delivered (their payload's
   * `tenantId`), and its dead letters (the package's `purge()`).
   * Custom for the pending ones: @nestjs/outbox deletes a message only as
   * published, so the store's table (`nest_outbox.messages`, the package's
   * PostgreSQL store) is cleared directly, leaving any under a live lease
   * (being delivered now; the next run takes what remains).
   */
  async removeMessages(tenantId: string) {
    const result = await database(this.txHost)
      .delete(outboxMessages)
      .where(
        and(
          eq(sql`${outboxMessages.payload}->>'tenantId'`, tenantId),
          or(
            isNull(outboxMessages.leaseUntil),
            lt(outboxMessages.leaseUntil, Date.now()),
          ),
        ),
      );
    const ids: string[] = [];
    for (let offset = 0; ; offset += PAGE) {
      const page = await this.deadLetters.list({ limit: PAGE, offset });
      ids.push(
        ...page
          .filter((letter) => ofTenant(letter.payload, tenantId))
          .map((letter) => letter.id),
      );
      if (page.length < PAGE) {
        break;
      }
    }
    if (ids.length > 0) {
      await this.deadLetters.purge(ids);
    }
    this.logger.log('A tenant’s outbox messages removed', {
      tenantId,
      // Database's portable result type is unknown; node-postgres reports rowCount.
      pending: (result as { rowCount?: number | null }).rowCount ?? 0,
      deadLetters: ids.length,
    });
  }

  /**
   * Every file under the tenant's prefix (`tenants/<id>/`: attachments,
   * documents, transfers, uploads), collected first, then deleted in
   * batches (deleting while a listing pages could skip some).
   */
  async removeFiles(tenantId: string) {
    const prefix = tenantFileKey(tenantId, '');
    const keys: string[] = [];
    for await (const entry of this.disk.listAll({ prefix })) {
      keys.push(entry.key);
    }
    for (let i = 0; i < keys.length; i += DELETE_BATCH) {
      await this.disk.delete(keys.slice(i, i + DELETE_BATCH));
    }
    this.logger.log('A tenant’s files removed', {
      tenantId,
      removed: keys.length,
    });
  }
}
