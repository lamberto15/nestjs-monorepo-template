import { Injectable, Logger } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { I18nService } from '@nestjs/i18n';
import { OnOneInstance, WithoutOverlapping } from '@nestjs/locks';
import { Cron } from '@nestjs/schedule';
import { and, desc, eq, inArray, isNotNull, lte } from 'drizzle-orm';
import {
  database,
  type DrizzleTransactions,
  inTransaction,
} from '../../core/database/transactions.js';
import { MailQueue } from '../../core/mail/mail-queue.js';
import { UsersRepository } from '../../iam/auth/users.repository.js';
import { NotificationCatalog } from './notification-catalog.js';
import { NotificationDigestMail } from './notification.mails.js';
import { notifications } from './notifications.tables.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { SystemContext } from '../../iam/access/system-context.js';
import { NOTIFICATION_DIGEST_JOB } from '../platform.jobs.js';

/** At most this many notifications are listed in one digest; the rest is a count. */
const DIGEST_ITEMS = 100;

/**
 * Mails the digests that are due: every hour, on one instance, one mail
 * per recipient with the notifications flagged for a digest whose time
 * has come (hourly ones at once, daily ones at NOTIFICATIONS_DIGEST_HOUR
 * in the recipient's zone). After downtime, everything due goes in the
 * next run. `run(now)` lets a test choose the moment.
 *
 * One mail per person, whatever the tenants: a digest is the person's, so
 * the job reads every tenant's due rows at once under the worker's
 * row-level security bypass (`Tenancy.bypass()`, docs/tenancy.md), and
 * lists a row only when it is the account's own (no tenant) or of a tenant
 * the person is still an active member of; the others are unflagged
 * unsent. The log names the tenants a run mailed for.
 */
@Injectable()
export class NotificationDigestJob {
  private readonly logger = new Logger('Notifications');

  /** The current transaction, or the database outside one (core/database/transactions.ts). */
  private get db() {
    return database(this.txHost);
  }

  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly users: UsersRepository,
    private readonly mailQueue: MailQueue,
    private readonly catalog: NotificationCatalog,
    private readonly i18n: I18nService,
    private readonly system: SystemContext,
    private readonly tenancy: Tenancy,
  ) {}

  @Cron('5 * * * *', {
    name: 'notification-digests',
    timeZone: process.env.APP_TIMEZONE || 'UTC',
  })
  @OnOneInstance({ key: 'notifications:digest' })
  @WithoutOverlapping()
  run(now = new Date()) {
    return this.system.run(
      NOTIFICATION_DIGEST_JOB,
      () =>
        this.tenancy.bypass(NOTIFICATION_DIGEST_JOB.key, async () => {
          const due = await this.db
            .selectDistinct({ recipient: notifications.recipient })
            .from(notifications)
            .where(
              and(
                isNotNull(notifications.digest),
                lte(notifications.digestDueAt, now),
              ),
            );
          let mails = 0;
          let items = 0;
          const tenants = new Set<string>();
          for (const { recipient } of due) {
            const user = recipient.startsWith('user:')
              ? await this.users.findActive(recipient.slice('user:'.length))
              : null;
            if (!user) {
              // Deactivated since: nothing to mail; the flags go.
              await this.db
                .update(notifications)
                .set({ digest: null, digestDueAt: null })
                .where(
                  and(
                    eq(notifications.recipient, recipient),
                    isNotNull(notifications.digest),
                  ),
                );
              continue;
            }
            const flagged = await this.db
              .select()
              .from(notifications)
              .where(
                and(
                  eq(notifications.recipient, recipient),
                  isNotNull(notifications.digest),
                  lte(notifications.digestDueAt, now),
                ),
              )
              .orderBy(desc(notifications.id));
            if (flagged.length === 0) continue;
            // Only what the person may still see: their own, and the tenants
            // they are still an active member of.
            const member = new Map<string, boolean>();
            for (const tenantId of new Set(
              flagged.flatMap((row) => (row.tenantId ? [row.tenantId] : [])),
            )) {
              member.set(
                tenantId,
                await this.users.isMember(user.id, tenantId),
              );
            }
            const rows = flagged.filter(
              (row) => !row.tenantId || member.get(row.tenantId),
            );
            await inTransaction(this.txHost, async (tx) => {
              if (rows.length > 0) {
                await tx
                  .update(notifications)
                  .set({ emailedAt: now, digest: null, digestDueAt: null })
                  .where(
                    inArray(
                      notifications.id,
                      rows.map((row) => row.id),
                    ),
                  );
              }
              const dropped = flagged.filter((row) => !rows.includes(row));
              if (dropped.length > 0) {
                await tx
                  .update(notifications)
                  .set({ digest: null, digestDueAt: null })
                  .where(
                    inArray(
                      notifications.id,
                      dropped.map((row) => row.id),
                    ),
                  );
              }
            });
            if (rows.length === 0) continue;
            for (const row of rows) {
              if (row.tenantId) tenants.add(row.tenantId);
            }
            const locale = user.locale ?? this.i18n.defaultLocale;
            const listed = rows.slice(0, DIGEST_ITEMS);
            try {
              await this.mailQueue.send(NotificationDigestMail, {
                to: { name: user.name, address: user.email },
                data: {
                  name: user.name,
                  items: listed.map((row) => ({
                    ...this.catalog.render(
                      row.type,
                      row.data,
                      row.count,
                      locale,
                    ),
                    link: row.link,
                    at: row.createdAt,
                  })),
                  count: rows.length,
                  more: rows.length - listed.length,
                  timezone: user.timezone,
                },
                locale,
              });
            } catch (error) {
              // The rows are marked: the digest is lost rather than sent twice.
              this.logger.error(
                `A digest could not be queued for ${recipient}`,
                {
                  error: error instanceof Error ? error.message : String(error),
                },
              );
              continue;
            }
            mails++;
            items += rows.length;
          }
          this.logger.log('Notification digests sent', {
            mails,
            items,
            tenants: [...tenants],
          });
          return { mails, items };
        }),
      { transaction: false },
    );
  }
}
