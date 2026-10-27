import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { I18nService } from '@nestjs/i18n';
import { and, eq, getTableColumns } from 'drizzle-orm';
import type { ListQuery } from '../../core/http/list-query.js';
import { walkList } from '../../core/http/pagination.js';
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

  /** In the list's order (`query.sort`, else newest first), by keyset. */
  async *batches(principal: Principal, query: Record<string, unknown>) {
    const list = query as ListQuery;
    const locale =
      principal.kind === 'user' && principal.locale
        ? principal.locale
        : this.i18n.defaultLocale;
    const where = and(
      eq(notifications.recipient, principalKey(principal)),
      NOTIFICATION_LIST.where(list),
    );
    const extra = NOTIFICATION_LIST.sortSelect(list);
    for await (const rows of walkList(
      notifications.id,
      list,
      ({ after, orderBy, limit }) =>
        this.db
          .select({ ...getTableColumns(notifications), ...extra })
          .from(notifications)
          .where(and(where, after))
          .orderBy(...orderBy)
          .limit(limit),
    )) {
      yield rows.map((row) => ({
        ...this.notifications.view(row, locale),
        // Dates, for the date-time columns (the view has ISO strings).
        readAt: row.readAt,
        createdAt: row.createdAt,
      }));
    }
  }
}
