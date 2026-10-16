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
      async () => {
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
          const rows = await this.db
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
          if (rows.length === 0) continue;
          await inTransaction(this.txHost, (tx) =>
            tx
              .update(notifications)
              .set({ emailedAt: now, digest: null, digestDueAt: null })
              .where(
                inArray(
                  notifications.id,
                  rows.map((row) => row.id),
                ),
              ),
          );
          const locale = user.locale ?? this.i18n.defaultLocale;
          const listed = rows.slice(0, DIGEST_ITEMS);
          try {
            await this.mailQueue.send(NotificationDigestMail, {
              to: { name: user.name, address: user.email },
              data: {
                name: user.name,
                items: listed.map((row) => ({
                  ...this.catalog.render(row.type, row.data, row.count, locale),
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
            this.logger.error(`A digest could not be queued for ${recipient}`, {
              error: error instanceof Error ? error.message : String(error),
            });
            continue;
          }
          mails++;
          items += rows.length;
        }
        this.logger.log('Notification digests sent', { mails, items });
        return { mails, items };
      },
      { transaction: false },
    );
  }
}
