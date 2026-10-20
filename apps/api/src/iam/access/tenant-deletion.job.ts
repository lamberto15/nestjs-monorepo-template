import { Injectable, Logger } from '@nestjs/common';
import { OnOneInstance, WithoutOverlapping } from '@nestjs/locks';
import { Cron } from '@nestjs/schedule';
import { TransactionHost } from '@nestjs-cls/transactional';
import { and, asc, eq, isNotNull, lte, sql } from 'drizzle-orm';
import {
  database,
  type DrizzleTransactions,
  inTransaction,
} from '../../core/database/transactions.js';
import {
  Tenancy,
  TenantRunsFailed,
} from '../../core/tenancy/tenancy.service.js';
import { type Tenant, tenants } from '../../core/tenancy/tenancy.tables.js';
import { AuditService } from '../audit/audit.service.js';
import type { SystemPrincipal } from '../auth/principal.js';
import { TENANT_DELETION_JOB } from '../iam.jobs.js';
import { ApiClientLifecycleRegistry } from './api-client-lifecycle.registry.js';
import { SystemContext } from './system-context.js';
import { TenantLifecycleRegistry } from './tenant-lifecycle.registry.js';
import { TenantsService } from './tenants.service.js';

/** Tenants erased per run at most: a backlog goes over the next nights. */
const BATCH = 50;

/**
 * Erases the tenants whose deletion an operator asked for
 * (`POST /v1/tenants/{id}/deletion`) once TENANT_DELETION_GRACE_DAYS
 * passed (docs/tenancy.md, "Deleting a tenant"), every night at 04:30 in
 * APP_TIMEZONE, on one instance, in a worker (cron jobs run only there),
 * as the system principal (`system:tenant-deletion`). Never in a request,
 * never the operator tenant.
 *
 * Each tenant in turn: claimed first under its row's lock
 * (`deletion_started_at`: no cancel from then on); then what lives outside
 * its tables goes (TenantLifecycleRegistry's `beforeErase`: its stored
 * files under `tenants/<id>/`, its queued jobs, workflows and outbox
 * messages, registered by the platform); then its row, the database
 * cascading to every tenant table's rows and its memberships, in one
 * transaction with the `tenant.purged` entry outside any tenant (the
 * tenant's own log goes with it: retention rules are roadmap item 5).
 * Before the row, its API clients' cleanups too (ApiClientLifecycleRegistry:
 * their webhook endpoints). A step that fails leaves the tenant claimed and
 * still there: the next night starts over (every step can run again),
 * and the failures are reported together (`TenantRunsFailed`).
 * `run(now)` lets a test choose the moment.
 */
@Injectable()
export class TenantDeletionJob {
  private readonly logger = new Logger(TenantDeletionJob.name);

  constructor(
    private readonly system: SystemContext,
    private readonly tenants: TenantsService,
    private readonly tenancy: Tenancy,
    private readonly audit: AuditService,
    private readonly lifecycle: TenantLifecycleRegistry,
    private readonly clientLifecycle: ApiClientLifecycleRegistry,
    private readonly txHost: TransactionHost<DrizzleTransactions>,
  ) {}

  @Cron('30 4 * * *', {
    name: 'tenant-deletion',
    timeZone: process.env.APP_TIMEZONE || 'UTC',
  })
  @OnOneInstance({ key: 'iam:tenant-deletion' })
  @WithoutOverlapping()
  run(now = new Date()): Promise<number> {
    return this.eraseDue(now);
  }

  /** The run itself, past the locks' decorators. */
  async eraseDue(now = new Date()): Promise<number> {
    const { erased, failures } = await this.system.run(
      TENANT_DELETION_JOB,
      async (system) => {
        let count = 0;
        const failed: { tenant: Tenant; error: unknown }[] = [];
        for (const tenant of await this.due(now)) {
          try {
            if (await this.erase(system, tenant, now)) {
              count++;
            }
          } catch (error) {
            failed.push({ tenant, error });
            this.logger.error(
              `${TENANT_DELETION_JOB.key}: failed for tenant ${tenant.slug}`,
              {
                tenant: tenant.id,
                error: error instanceof Error ? error.message : String(error),
              },
            );
          }
        }
        return { erased: count, failures: failed };
      },
      // Transactions of its own per tenant; global tables, no tenant to start with.
      { transaction: false, tenantId: null },
    );
    if (erased > 0 || failures.length > 0) {
      this.logger.log('Tenants erased', { erased, failed: failures.length });
    }
    if (failures.length > 0) {
      throw new TenantRunsFailed(TENANT_DELETION_JOB.key, failures);
    }
    return erased;
  }

  /** The tenants whose erase is due, oldest schedule first. */
  private due(now: Date) {
    return database(this.txHost)
      .select()
      .from(tenants)
      .where(
        and(
          isNotNull(tenants.deletionScheduledFor),
          lte(tenants.deletionScheduledFor, now),
          eq(tenants.operator, false),
        ),
      )
      .orderBy(asc(tenants.deletionScheduledFor))
      .limit(BATCH);
  }

  /** One tenant: claimed, its outside things, its row and the entry; its clients' cleanups. */
  private async erase(system: SystemPrincipal, due: Tenant, now: Date) {
    // Under the row's lock (the UPDATE's), conditional: a deletion cancelled
    // since the list was read is skipped; from here on no cancel takes it back.
    const [claimed] = await inTransaction(this.txHost, (tx) =>
      tx
        .update(tenants)
        .set({
          deletionStartedAt: sql`coalesce(${tenants.deletionStartedAt}, now())`,
        })
        .where(
          and(
            eq(tenants.id, due.id),
            eq(tenants.operator, false),
            isNotNull(tenants.deletionScheduledFor),
            lte(tenants.deletionScheduledFor, now),
          ),
        )
        .returning(),
    );
    if (!claimed) {
      return false;
    }
    for (const listener of this.lifecycle.all()) {
      await listener.beforeErase?.(claimed.id);
    }
    // Its API clients' cleanups (their webhook endpoints: URLs, signing
    // secrets), as a client's own deletion runs them, but before the row
    // goes and without catching: one that fails stops the erase, and the
    // next night tries again, rather than leave them behind for good.
    const clients = (await this.tenants.principalsOf(claimed.id)).filter(
      (principal) => principal.kind === 'client',
    );
    await this.tenancy.run(claimed.id, async () => {
      for (const { id } of clients) {
        for (const listener of this.clientLifecycle.all()) {
          await listener.afterDeletion(id, claimed.id);
        }
      }
    });
    const deleted = await inTransaction(this.txHost, async (tx) => {
      const row = await this.tenants.deleteRow(tx, claimed.id);
      if (!row) {
        return undefined;
      }
      await this.audit.record(
        system,
        {
          action: 'tenant.purged',
          targetType: 'tenant',
          targetId: row.id,
          details: {
            slug: row.slug,
            name: row.name,
            reason: 'deletion',
            requestedAt: row.deletionRequestedAt?.toISOString() ?? null,
            scheduledFor: row.deletionScheduledFor?.toISOString() ?? null,
          },
        },
        tx,
      );
      return row;
    });
    if (!deleted) {
      return false;
    }
    this.logger.log(`Tenant ${claimed.slug} erased`, { tenant: claimed.id });
    return true;
  }
}
