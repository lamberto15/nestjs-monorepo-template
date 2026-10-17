import { Injectable, NotFoundException } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { and, eq, inArray } from 'drizzle-orm';
import { RecordPurgeRegistry } from '../../iam/resources/record-purge.registry.js';
import type { Transaction } from '../../core/database/drizzle.js';
import {
  database,
  type DrizzleTransactions,
  inTransaction,
} from '../../core/database/transactions.js';
import type { ListQuery } from '../../core/http/list-query.js';
import {
  afterCursor,
  countPage,
  pageOffset,
  pageOrder,
  toPage,
} from '../../core/http/pagination.js';
import { type Principal, principalKey } from '../../iam/auth/principal.js';
import {
  NotificationsService,
  type NotifyInput,
} from '../notifications/notifications.service.js';
import { SUBSCRIPTION_LIST } from './subscription.list.js';
import { SubscriptionsRegistry } from './subscriptions.registry.js';
import { recordSubscriptions } from './subscriptions.tables.js';

/** A record, by its permission subject and id. */
export interface RecordRef {
  subject: string;
  recordId: string;
}

/**
 * Watching records: a principal follows a record and is notified when it
 * changes. The feature decides who may watch (its SubscriptionTarget, which
 * `watch()` asks: `POST /<path>/{id}/watch`, subscription.routes.ts),
 * watches creators by default (`subscribe` in the create's transaction),
 * and tells the watchers in each change's transaction
 * (`notifyWatchers`, through the notification system: in-app, realtime,
 * mail or webhook as each prefers). Watching is the watcher's own:
 * `GET /subscriptions` lists theirs, `DELETE` ends one.
 */
@Injectable()
export class SubscriptionsService {
  /** The current transaction, or the database outside one (core/database/transactions.ts). */
  private get db() {
    return database(this.txHost);
  }

  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly notifications: NotificationsService,
    private readonly registry: SubscriptionsRegistry,
    purges: RecordPurgeRegistry,
  ) {
    // A record purged from its recycle bin: nobody watches it any more.
    purges.register({
      name: 'subscriptions',
      forget: (tx, subject, ids) => this.forgetAll(tx, subject, ids),
    });
  }

  /**
   * Starts watching a record its feature lets the principal watch (the
   * subject's SubscriptionTarget: a 404 or 403 from it otherwise).
   */
  async watch(principal: Principal, record: RecordRef) {
    const target = this.registry.find(record.subject);
    if (!target) {
      throw new Error(
        `No SubscriptionTarget for "${record.subject}": register one (subscriptions.registry.ts).`,
      );
    }
    await target.assertCanWatch(principal, record.recordId);
    await this.subscribe(principal, record);
  }

  /**
   * Starts watching (again: no change). Joins the current transaction.
   * The system principal watches nothing (it gets no notifications): a
   * job that comments or creates a record isn't subscribed.
   */
  async subscribe(
    principal: Pick<Principal, 'kind' | 'id'>,
    record: RecordRef,
  ) {
    if (principal.kind === 'system') {
      return;
    }
    await inTransaction(this.txHost, (tx) =>
      tx
        .insert(recordSubscriptions)
        .values({ ...record, subscriber: principalKey(principal) })
        .onConflictDoNothing(),
    );
  }

  /** Stops watching; false when the principal wasn't. */
  async unsubscribe(
    principal: Pick<Principal, 'kind' | 'id'>,
    record: RecordRef,
  ) {
    const deleted = await this.db
      .delete(recordSubscriptions)
      .where(this.one(principal, record))
      .returning({ id: recordSubscriptions.id });
    return deleted.length > 0;
  }

  async isWatching(
    principal: Pick<Principal, 'kind' | 'id'>,
    record: RecordRef,
  ) {
    const [row] = await this.db
      .select({ id: recordSubscriptions.id })
      .from(recordSubscriptions)
      .where(this.one(principal, record));
    return row !== undefined;
  }

  /** The principal keys watching a record. */
  async watchers(record: RecordRef): Promise<string[]> {
    const rows = await this.db
      .select({ subscriber: recordSubscriptions.subscriber })
      .from(recordSubscriptions)
      .where(
        and(
          eq(recordSubscriptions.subject, record.subject),
          eq(recordSubscriptions.recordId, record.recordId),
        ),
      );
    return rows.map((row) => row.subscriber);
  }

  /**
   * Notifies the record's watchers, in `tx` (the change's transaction),
   * but `except` (the one who made the change: they know). Returns the
   * notification ids; call `notifications.deliverNow()` after the commit.
   */
  async notifyWatchers(
    tx: Transaction,
    input: RecordRef &
      Omit<NotifyInput, 'to'> & {
        except?: Pick<Principal, 'kind' | 'id'> | string;
      },
  ) {
    const { subject, recordId, except, ...notification } = input;
    const skip =
      except === undefined
        ? null
        : typeof except === 'string'
          ? except
          : principalKey(except);
    const to = (await this.watchers({ subject, recordId })).filter(
      (watcher) => watcher !== skip,
    );
    return this.notifications.notify(tx, { ...notification, to });
  }

  /** A page of what the principal watches. */
  async page(principal: Principal, query: ListQuery) {
    const where = and(
      eq(recordSubscriptions.subscriber, principalKey(principal)),
      SUBSCRIPTION_LIST.where(query),
    );
    const [rows, total] = await Promise.all([
      this.db
        .select()
        .from(recordSubscriptions)
        .where(and(where, afterCursor(recordSubscriptions.id, query)))
        .orderBy(...pageOrder(recordSubscriptions.id, query))
        .limit(query.limit + 1)
        .offset(pageOffset(query)),
      countPage(this.db, recordSubscriptions, where, query),
    ]);
    const page = toPage(rows, query, total);
    return {
      ...page,
      items: page.items.map((row) => ({
        subject: row.subject,
        recordId: row.recordId,
        createdAt: row.createdAt.toISOString(),
      })),
    };
  }

  /** Ends one of the principal's subscriptions, or a 404. */
  async remove(principal: Principal, record: RecordRef) {
    if (!(await this.unsubscribe(principal, record))) {
      throw new NotFoundException(
        `You are not watching ${record.subject} ${record.recordId}.`,
      );
    }
  }

  /** When a record is gone for good: nobody watches it any more. */
  async forget(tx: Transaction, record: RecordRef) {
    await this.forgetAll(tx, record.subject, [record.recordId]);
  }

  /** `forget()` for many records of a subject (the soft-delete purge's batch). */
  async forgetAll(tx: Transaction, subject: string, recordIds: string[]) {
    await tx
      .delete(recordSubscriptions)
      .where(
        and(
          eq(recordSubscriptions.subject, subject),
          inArray(recordSubscriptions.recordId, recordIds),
        ),
      );
  }

  /** When a principal is gone (their account deleted): they watch nothing. */
  async erase(tx: Transaction, principal: Pick<Principal, 'kind' | 'id'>) {
    await tx
      .delete(recordSubscriptions)
      .where(eq(recordSubscriptions.subscriber, principalKey(principal)));
  }

  private one(principal: Pick<Principal, 'kind' | 'id'>, record: RecordRef) {
    return and(
      eq(recordSubscriptions.subject, record.subject),
      eq(recordSubscriptions.recordId, record.recordId),
      eq(recordSubscriptions.subscriber, principalKey(principal)),
    );
  }
}
