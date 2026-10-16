import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { I18nService } from '@nestjs/i18n';
import { and, desc, eq, lt } from 'drizzle-orm';
import {
  database,
  type DrizzleTransactions,
} from '../../core/database/transactions.js';
import { type Principal, principalKey } from '../../iam/auth/principal.js';
import { DataTransferRegistry } from '../data-transfer/data-transfer.registry.js';
import type {
  DataExporter,
  TransferColumn,
} from '../data-transfer/data-transfer.types.js';
import { NOTIFICATION_LIST } from './notification.list.js';
import { notifications } from './notifications.tables.js';
import { NotificationsService } from './notifications.service.js';

/**
 * A principal's notifications as CSV, JSON or Excel (POST /data/exports
 * { name: 'notifications' }): their own only, so no permission is needed;
 * the texts in their language.
 */
@Injectable()
export class NotificationTransfer implements DataExporter<
  Record<string, unknown>
> {
  readonly name = 'notifications';
  readonly subject = 'Notification';
  readonly columns: readonly TransferColumn[] = [
    { key: 'id' },
    { key: 'type' },
    { key: 'title' },
    { key: 'body' },
    { key: 'link' },
    { key: 'count' },
    { key: 'read' },
    { key: 'readAt', type: 'datetime' },
    { key: 'createdAt', type: 'datetime' },
  ];
  readonly filters = NOTIFICATION_LIST.schema;

  /** The current transaction, or the database outside one (core/database/transactions.ts). */
  private get db() {
    return database(this.txHost);
  }

  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly notifications: NotificationsService,
    private readonly i18n: I18nService,
    registry: DataTransferRegistry,
  ) {
    registry.registerExporter(this);
  }

  /** The caller's own records: no permission to check. */
  allowed() {
    return true;
  }

  async *batches(principal: Principal, filters: Record<string, unknown>) {
    const locale =
      principal.kind === 'user' && principal.locale
        ? principal.locale
        : this.i18n.defaultLocale;
    const where = and(
      eq(notifications.recipient, principalKey(principal)),
      NOTIFICATION_LIST.where({ limit: 1000, ...filters }),
    );
    let cursor: string | undefined;
    for (;;) {
      const rows = await this.db
        .select()
        .from(notifications)
        .where(and(where, cursor ? lt(notifications.id, cursor) : undefined))
        .orderBy(desc(notifications.id))
        .limit(1000);
      if (rows.length === 0) {
        return;
      }
      yield rows.map((row) => ({
        ...this.notifications.view(row, locale),
        // Dates, for the date-time columns (the view has ISO strings).
        readAt: row.readAt,
        createdAt: row.createdAt,
      }));
      cursor = rows[rows.length - 1]!.id;
    }
  }
}
