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
import { UsersRepository } from '../../iam/auth/users.repository.js';
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
 * (name, address, password, sign-in methods, sessions, tokens, roles,
 * units; their audit entries keep the actor key, not the name), their
 * notifications, preferences and settings go, and each feature erases
 * what it must (`PersonalDataSource.erase`). Records they created stay.
 * As the system principal (`system:account-deletion`, the actor of each
 * `account.deleted` entry), one transaction per account. `run(now)` lets
 * a test choose the moment.
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
      { transaction: false }, // one per account
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
    for (const request of due) {
      const user = await this.users.findView(request.userId);
      if (!user) {
        continue; // gone already (cascade)
      }
      const key = principalKey(user);
      const done = await inTransaction(this.txHost, async (tx) => {
        // Still pending, and locked: a cancel (signed in, or the mail's
        // link) that committed since the list was read wins, and one
        // arriving now waits for this transaction, then finds it done.
        const [pending] = await tx
          .select({ id: accountDeletions.id })
          .from(accountDeletions)
          .where(
            and(
              eq(accountDeletions.id, request.id),
              isNull(accountDeletions.cancelledAt),
              isNull(accountDeletions.completedAt),
            ),
          )
          .for('update');
        if (!pending) {
          return false;
        }
        for (const source of this.personalData.all()) {
          await source.erase?.(tx, user);
        }
        await tx.delete(notifications).where(eq(notifications.recipient, key));
        await tx
          .delete(notificationPreferences)
          .where(eq(notificationPreferences.recipient, key));
        await tx
          .delete(settingOverrides)
          .where(
            and(
              eq(settingOverrides.scope, 'user'),
              eq(settingOverrides.scopeId, key),
            ),
          );
        await this.subscriptions.erase(tx, user);
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
            details: { requestedAt: request.requestedAt.toISOString() },
          },
          tx,
        );
        return true;
      });
      if (done) {
        deleted++;
      }
    }
    this.logger.log('Accounts deleted', { deleted });
    return deleted;
  }
}
