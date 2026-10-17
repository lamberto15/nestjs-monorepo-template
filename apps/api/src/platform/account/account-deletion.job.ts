import { Injectable, Logger } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { OnOneInstance, WithoutOverlapping } from '@nestjs/locks';
import { Cron } from '@nestjs/schedule';
import { and, eq, isNull, lte } from 'drizzle-orm';
import {
  database,
  type DrizzleTransactions,
  inTransaction,
} from '../../core/database/transactions.js';
import { SystemContext } from '../../iam/access/system-context.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import {
  principalKey,
  type SystemPrincipal,
} from '../../iam/auth/principal.js';
import {
  DELETED_USER_NAME,
  UsersRepository,
} from '../../iam/auth/users.repository.js';
import type { Transaction } from '../../core/database/drizzle.js';
import { auditLog, memberships } from '../../iam/iam.tables.js';
import {
  notificationPreferences,
  notifications,
} from '../notifications/notifications.tables.js';
import { ACCOUNT_DELETION_JOB } from '../platform.jobs.js';
import { settingOverrides } from '../settings/settings.tables.js';
import { SubscriptionsService } from '../subscriptions/subscriptions.service.js';
import { accountDeletions } from './account.tables.js';
import { PersonalDataRegistry } from './personal-data.registry.js';

/**
 * Carries out the account deletions whose grace period passed, every
 * night at 03:50 in APP_TIMEZONE, on one instance: the user is anonymized
 * (name, address, password, sign-in methods, sessions, tokens,
 * memberships with their roles and units; their audit entries keep the
 * actor key, not the name), their notifications, preferences and settings
 * go, and each feature erases what it must (`PersonalDataSource.erase`).
 * Records they created stay. As the system principal
 * (`system:account-deletion`, the actor of each `account.deleted` entry).
 *
 * A person spans tenants (docs/tenancy.md): their data is erased in each
 * tenant they belong to (every membership, active or not), one
 * transaction per tenant in that tenant's scope (never the row-level
 * security bypass), then the account itself is anonymized and the
 * deletion completed in one last transaction outside any tenant. Every
 * step can run again: a run cut short leaves the request open, and the
 * next night finishes it. `run(now)` lets a test choose the moment.
 */
@Injectable()
export class AccountDeletionJob {
  private readonly logger = new Logger('AccountDeletion');

  /** The current transaction, or the database outside one (core/database/transactions.ts). */
  private get db() {
    return database(this.txHost);
  }

  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly users: UsersRepository,
    private readonly personalData: PersonalDataRegistry,
    private readonly audit: AuditService,
    private readonly subscriptions: SubscriptionsService,
    private readonly system: SystemContext,
  ) {}

  @Cron('50 3 * * *', {
    name: 'account-deletion',
    timeZone: process.env.APP_TIMEZONE || 'UTC',
  })
  @OnOneInstance({ key: 'platform:account-deletion' })
  @WithoutOverlapping()
  run(now = new Date()) {
    return this.system.run(
      ACCOUNT_DELETION_JOB,
      (system) => this.deleteDue(system, now),
      // Transactions of its own, per tenant and per account; no tenant to start with.
      { transaction: false, tenantId: null },
    );
  }

  private async deleteDue(system: SystemPrincipal, now: Date) {
    const due = await this.db
      .select()
      .from(accountDeletions)
      .where(
        and(
          lte(accountDeletions.scheduledFor, now),
          isNull(accountDeletions.cancelledAt),
          isNull(accountDeletions.completedAt),
        ),
      );
    let deleted = 0;
    // One account's failure in one tenant never stops the others: that
    // account stays open (its request too) and the next night tries again;
    // every failure is logged here and reported at the end.
    const failures: {
      userId: string;
      tenantId: string | null;
      error: unknown;
    }[] = [];
    for (const request of due) {
      const user = await this.users.findView(request.userId);
      if (!user) {
        continue; // gone already (cascade)
      }
      const key = principalKey(user);
      // Before the anonymization, which removes the memberships.
      const tenants = await this.db
        .select({ tenantId: memberships.tenantId })
        .from(memberships)
        .where(eq(memberships.userId, user.id));
      let erased = true;
      for (const { tenantId } of tenants) {
        try {
          await this.system.run(
            ACCOUNT_DELETION_JOB,
            async (_system, tx) => {
              const member = { ...user, tenantId };
              for (const source of this.personalData.all()) {
                await source.erase?.(tx, member);
              }
              await tx
                .delete(notifications)
                .where(eq(notifications.recipient, key));
              await tx
                .delete(settingOverrides)
                .where(
                  and(
                    eq(settingOverrides.scope, 'user'),
                    eq(settingOverrides.scopeId, key),
                  ),
                );
              await this.subscriptions.erase(tx, member);
              await relabel(tx, key);
            },
            { tenantId },
          );
          this.logger.log('Account erased in a tenant', {
            tenant: tenantId,
            userId: user.id,
          });
        } catch (error) {
          erased = false;
          failures.push({ userId: user.id, tenantId, error });
          this.logger.error('Account not erased in a tenant', {
            tenant: tenantId,
            userId: user.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      if (!erased) {
        continue; // anonymized only once every tenant erased it
      }
      try {
        await inTransaction(this.txHost, async (tx) => {
          // The account's own (no tenant): its security notifications, its
          // preferences, its sign-in and sign-up entries.
          await tx
            .delete(notifications)
            .where(eq(notifications.recipient, key));
          await tx
            .delete(notificationPreferences)
            .where(eq(notificationPreferences.recipient, key));
          await relabel(tx, key);
          await this.users.anonymize(tx, user.id);
          await tx
            .update(accountDeletions)
            .set({ completedAt: now })
            .where(eq(accountDeletions.id, request.id));
          await this.audit.record(
            system,
            {
              action: 'account.deleted',
              targetType: 'user',
              targetId: user.id,
              details: {
                requestedAt: request.requestedAt.toISOString(),
                tenants: tenants.length,
              },
            },
            tx,
          );
        });
        deleted++;
      } catch (error) {
        failures.push({ userId: user.id, tenantId: null, error });
        this.logger.error('Account not anonymized', {
          userId: user.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    this.logger.log('Accounts deleted', { deleted });
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map((failure) => failure.error),
        `account-deletion failed for ${failures.length} step(s): ${failures
          .map(
            (failure) =>
              `user ${failure.userId} in ${failure.tenantId ?? 'no tenant'}`,
          )
          .join('; ')}`,
      );
    }
    return deleted;
  }
}

/**
 * The person's audit entries in the current scope keep their actor key and
 * lose the address: labelled "Deleted user".
 */
const relabel = (tx: Transaction, key: string) =>
  tx
    .update(auditLog)
    .set({ actorLabel: DELETED_USER_NAME })
    .where(eq(auditLog.actor, key));
