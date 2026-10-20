import { Injectable, Logger } from '@nestjs/common';
import { OnOneInstance, WithoutOverlapping } from '@nestjs/locks';
import { Cron } from '@nestjs/schedule';
import { TransactionHost } from '@nestjs-cls/transactional';
import { and, eq, exists, gt, inArray, lt, not, sql } from 'drizzle-orm';
import {
  database,
  type DrizzleTransactions,
  inTransaction,
} from '../../core/database/transactions.js';
import { type Tenant, tenants } from '../../core/tenancy/tenancy.tables.js';
import { TenantRunsFailed } from '../../core/tenancy/tenancy.service.js';
import { AuditService } from '../audit/audit.service.js';
import type { SystemPrincipal } from '../auth/principal.js';
import { SIGN_UP_TENANT_SWEEP_JOB } from '../iam.jobs.js';
import { emailTokens, memberships, users } from '../iam.tables.js';
import { SystemContext } from './system-context.js';
import { TenantsService } from './tenants.service.js';

/**
 * How long past its sign-up (and past its last verification link's expiry,
 * the link lasting 24 hours, and a resend making a new one) a tenant whose
 * accounts never proved their address is kept.
 */
export const UNVERIFIED_SIGN_UP_GRACE_DAYS = 7;
/** Tenants deleted per run at most: a backlog goes over the next nights. */
const BATCH = 500;

/**
 * Deletes the tenants a self sign-up made (TENANT_SIGN_UP,
 * `tenants.created_by_sign_up`) whose accounts never proved their address:
 * made more than UNVERIFIED_SIGN_UP_GRACE_DAYS ago, no member verified, no
 * member's verification link still valid within the grace. A sign-up makes
 * its tenant before the address is proved (docs/tenancy.md, "Tenants made at
 * sign-up"), so without this, sign-ups nobody finishes (bots past the rate
 * limit, typos) would pile tenants up. Every night at 04:15 in APP_TIMEZONE,
 * on one instance (@nestjs/locks), in a worker (cron jobs run only there),
 * as the system principal (`system:sign-up-tenant-sweep`). A tenant that
 * fails is logged and skipped; the others go on, and the failures are
 * reported together at the end (`TenantRunsFailed`), as `forEachTenant()`.
 *
 * Global tables only (tenants, memberships, users, email tokens), outside
 * any tenant: each tenant is deleted in its own transaction under its
 * members' account locks (an address proved meanwhile keeps its tenant),
 * and the deletion is audited outside any tenant (`tenant.purged`), since
 * the tenant's own log goes with it. The accounts stay: unverified, in no
 * tenant, as a sign-up with TENANT_SIGN_UP off would be.
 */
@Injectable()
export class SignUpTenantSweepJob {
  private readonly logger = new Logger(SignUpTenantSweepJob.name);

  constructor(
    private readonly system: SystemContext,
    private readonly tenants: TenantsService,
    private readonly audit: AuditService,
    private readonly txHost: TransactionHost<DrizzleTransactions>,
  ) {}

  @Cron('15 4 * * *', {
    name: 'sign-up-tenant-sweep',
    timeZone: process.env.APP_TIMEZONE || 'UTC',
  })
  @OnOneInstance({ key: 'iam:sign-up-tenant-sweep' })
  @WithoutOverlapping()
  run(): Promise<number> {
    return this.sweepAll();
  }

  /** The run itself, past the locks' decorators (`run()`: on one instance, never overlapping). */
  async sweepAll(): Promise<number> {
    const cutoff = new Date(
      Date.now() - UNVERIFIED_SIGN_UP_GRACE_DAYS * 86_400_000,
    );
    const { deleted, failures } = await this.system.run(
      SIGN_UP_TENANT_SWEEP_JOB,
      async (system) => {
        let count = 0;
        const failed: { tenant: Tenant; error: unknown }[] = [];
        // One tenant's failure doesn't stop the others (as forEachTenant()):
        // logged with the tenant, reported together at the end.
        for (const tenant of await this.candidates(cutoff)) {
          try {
            if (await this.sweep(system, tenant.id, cutoff)) {
              count++;
            }
          } catch (error) {
            failed.push({ tenant, error });
            this.logger.error(
              `${SIGN_UP_TENANT_SWEEP_JOB.key}: failed for tenant ${tenant.slug}`,
              {
                tenant: tenant.id,
                error: error instanceof Error ? error.message : String(error),
              },
            );
          }
        }
        return { deleted: count, failures: failed };
      },
      { transaction: false, tenantId: null },
    );
    if (deleted > 0 || failures.length > 0) {
      this.logger.log('Unverified sign-ups’ tenants deleted', {
        deleted,
        failed: failures.length,
        days: UNVERIFIED_SIGN_UP_GRACE_DAYS,
      });
    }
    if (failures.length > 0) {
      throw new TenantRunsFailed(SIGN_UP_TENANT_SWEEP_JOB.key, failures);
    }
    return deleted;
  }

  /** The sign-up tenants past the grace whose members are all unverified, with no link left. */
  private candidates(cutoff: Date) {
    const db = database(this.txHost);
    return db
      .select()
      .from(tenants)
      .where(
        and(
          eq(tenants.createdBySignUp, true),
          eq(tenants.operator, false),
          lt(tenants.createdAt, cutoff),
          not(
            exists(
              db
                .select({ one: sql`1` })
                .from(memberships)
                .innerJoin(users, eq(users.id, memberships.userId))
                .where(
                  and(
                    eq(memberships.tenantId, tenants.id),
                    eq(users.emailVerified, true),
                  ),
                ),
            ),
          ),
          not(
            exists(
              db
                .select({ one: sql`1` })
                .from(memberships)
                .innerJoin(
                  emailTokens,
                  eq(emailTokens.userId, sql`${memberships.userId}::text`),
                )
                .where(
                  and(
                    eq(memberships.tenantId, tenants.id),
                    eq(emailTokens.purpose, 'email-verification'),
                    gt(emailTokens.expiresAt, cutoff),
                  ),
                ),
            ),
          ),
        ),
      )
      .orderBy(tenants.createdAt)
      .limit(BATCH);
  }

  /**
   * One tenant, in one transaction: its members' accounts locked, checked
   * again (one verified since the listing keeps it), the row deleted
   * (TenantsService.deleteRow(): the database cascades to its rows and
   * memberships), and the entry outside any tenant.
   */
  private sweep(system: SystemPrincipal, tenantId: string, cutoff: Date) {
    return inTransaction(this.txHost, async (tx) => {
      const members = await tx
        .select({ id: users.id, verified: users.emailVerified })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(eq(memberships.tenantId, tenantId))
        .for('update', { of: users });
      if (members.some(({ verified }) => verified)) {
        return false;
      }
      if (members.length > 0) {
        const [pending] = await tx
          .select({ id: emailTokens.id })
          .from(emailTokens)
          .where(
            and(
              inArray(
                emailTokens.userId,
                members.map(({ id }) => id),
              ),
              eq(emailTokens.purpose, 'email-verification'),
              gt(emailTokens.expiresAt, cutoff),
            ),
          )
          .limit(1);
        if (pending) {
          return false;
        }
      }
      const tenant = await this.tenants.deleteRow(tx, tenantId);
      if (!tenant) {
        return false;
      }
      await this.audit.record(
        system,
        {
          action: 'tenant.purged',
          targetType: 'tenant',
          targetId: tenant.id,
          details: {
            slug: tenant.slug,
            name: tenant.name,
            reason: 'sign-up-unverified',
            members: members.map(({ id }) => id),
            days: UNVERIFIED_SIGN_UP_GRACE_DAYS,
          },
        },
        tx,
      );
      return true;
    });
  }
}
