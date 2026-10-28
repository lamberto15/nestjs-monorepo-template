import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TransactionHost } from '@nestjs-cls/transactional';
import { Outbox, type NewOutboxMessage } from '@nestjs/outbox';
import {
  and,
  count,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  sql,
} from 'drizzle-orm';
import type { CoreEnv } from '../../core/config/core.env.js';
import type { Transaction } from '../../core/database/drizzle.js';
import { currentTenantId } from '../../core/tenancy/tenant-scope.js';
import { tenantPredicate } from '../../core/tenancy/tenant-query.js';
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
import { AuditService } from '../../iam/audit/audit.service.js';
import {
  type Principal,
  principalKey,
  type UserPrincipal,
} from '../../iam/auth/principal.js';
import { Realtime } from '../realtime/realtime.service.js';
import { NotificationCatalog } from './notification-catalog.js';
import { NOTIFICATION_LIST } from './notification.list.js';
import type { NotificationView } from './notification.schemas.js';
import {
  NOTIFICATION_EVENTS,
  NOTIFICATIONS_TOPIC,
  type Notification,
  type NotificationMessage,
  type NotificationType,
  type PreferenceOverrides,
} from './notification.types.js';
import {
  notificationPreferences,
  notifications,
} from './notifications.tables.js';
import type { QuietHours } from './quiet-hours.js';

/** At most this many recipients per `notify()`: a broadcast is chunked through a queue job. */
export const MAX_RECIPIENTS = 500;

/** The unread count stops here (`unreadCapped`): counting a big backlog exactly costs a read of all of it. */
export const UNREAD_COUNT_CAP = 1_000;

/** Rows one read-all statement updates. */
export const READ_ALL_BATCH = 5_000;

export interface NotifyInput {
  type: NotificationType;
  /** Who gets it: principals, or their keys (`user:<id>`, `client:<id>`). */
  to:
    | Pick<Principal, 'kind' | 'id'>
    | string
    | readonly (Pick<Principal, 'kind' | 'id'> | string)[];
  /** The placeholders of the title and body, and what a client needs to act. */
  data: Record<string, unknown>;
  /** A newer notification with the same key replaces the older one, counted up. */
  key?: string;
  /** Where to go about it: a path of the web app. */
  link?: string;
}

/**
 * Notifications: features call `notify()` inside the transaction of the
 * change (the stored notification and its delivery commit with it; the
 * outbox hands it to the delivery handler on a worker), recipients read,
 * mark and remove theirs, and set their preferences. Every read and write
 * for the API is scoped to the caller: nobody sees another's; in a tenant,
 * that tenant's and the account's own (no tenant: security notifications),
 * which row-level security gives (docs/tenancy.md).
 * Preferences are the person's, global (the same in every tenant). Each change
 * is pushed to the caller's other connections too (a badge in every tab).
 */
@Injectable()
export class NotificationsService {
  /** The current transaction, or the database outside one (core/database/transactions.ts). */
  private get db() {
    return database(this.txHost);
  }

  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly catalog: NotificationCatalog,
    private readonly outbox: Outbox<Transaction>,
    private readonly audit: AuditService,
    private readonly realtime: Realtime,
    private readonly config: ConfigService<CoreEnv, true>,
  ) {}

  /**
   * Tells the recipients, in `tx` (the change's transaction): one stored
   * notification each, delivered by the worker once `tx` commits. Returns
   * their ids. Call `deliverNow()` after the commit to skip the relay's poll.
   */
  async notify(tx: Transaction, input: NotifyInput): Promise<string[]> {
    const declaration = this.catalog.declaration(input.type);
    if (!declaration) {
      throw new Error(
        `Notification type "${input.type}" is not declared: PlatformModule.forRoot({ notifications }).`,
      );
    }
    const data = (
      declaration.data ? declaration.data.parse(input.data) : input.data
    ) as Record<string, unknown>;
    const to = Array.isArray(input.to) ? input.to : [input.to];
    const recipients = [
      ...new Set(
        (to as (Pick<Principal, 'kind' | 'id'> | string)[]).map((recipient) =>
          typeof recipient === 'string' ? recipient : principalKey(recipient),
        ),
      ),
      // The system principal (a job that owns or watches a record) has
      // nobody to tell: it gets no notification.
    ].filter((recipient) => !recipient.startsWith('system:'));
    if (recipients.length === 0) {
      return [];
    }
    if (recipients.length > MAX_RECIPIENTS) {
      throw new Error(
        `notify() takes at most ${MAX_RECIPIENTS} recipients at once: chunk a broadcast through a queue job.`,
      );
    }
    const key =
      input.key ?? (declaration.collapse ? `type:${input.type}` : null);
    // Stored in the context's tenant (the column's default), or as the
    // account's own outside any tenant (a sign-in's security notification):
    // collapsing happens within it, and the delivery restores it.
    const tenantId = currentTenantId();
    const link = input.link ?? null;
    const ids: string[] = [];
    const messages: NewOutboxMessage<NotificationMessage>[] = [];
    for (const recipient of recipients) {
      let count = 1;
      if (key) {
        // Collapse: the older one goes, its count carries over. Concurrent
        // notifies of one key wait for each other instead of one failing on
        // the unique index (which would fail the caller's transaction).
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${`${tenantId ?? ''}:${recipient}:${key}`}))`,
        );
        const [old] = await tx
          .delete(notifications)
          .where(
            and(
              eq(notifications.recipient, recipient),
              eq(notifications.key, key),
              // This tenant's (or the account's own): a person's null-tenant
              // rows are writable from any tenant, and must not go here.
              tenantId
                ? eq(notifications.tenantId, tenantId)
                : isNull(notifications.tenantId),
            ),
          )
          .returning({ count: notifications.count });
        count = (old?.count ?? 0) + 1;
      }
      const [row] = await tx
        .insert(notifications)
        .values({ recipient, type: input.type, data, key, link, count })
        .returning({ id: notifications.id });
      ids.push(row!.id);
      // No ordering key: nothing depends on the order of a recipient's deliveries (the list sorts by id, a collapsed one's delivery finds nothing), and a key would deliver a recipient's backlog one at a time and hold it behind a retry.
      messages.push({
        topic: NOTIFICATIONS_TOPIC,
        key: null,
        payload: {
          notificationId: row!.id,
          recipient,
          type: input.type,
          tenantId,
        },
      });
    }
    await this.outbox.add(tx, messages);
    return ids;
  }

  /** Stores many notifications and their outbox messages with grouped locks and multi-row writes. */
  async notifyMany(
    tx: Transaction,
    inputs: readonly NotifyInput[],
  ): Promise<string[][]> {
    if (!inputs.length) return [];
    const tenantId = currentTenantId();
    const prepared: {
      input: NotifyInput;
      recipients: string[];
      key: string | null;
      data: Record<string, unknown>;
      ids: string[];
    }[] = [];
    for (const input of inputs) {
      const declaration = this.catalog.declaration(input.type);
      if (!declaration)
        throw new Error(`Notification type "${input.type}" is not declared.`);
      const data = (
        declaration.data ? declaration.data.parse(input.data) : input.data
      ) as Record<string, unknown>;
      const to = Array.isArray(input.to) ? input.to : [input.to];
      const recipients = [
        ...new Set(
          to.map((recipient) =>
            typeof recipient === 'string' ? recipient : principalKey(recipient),
          ),
        ),
      ].filter((recipient) => !recipient.startsWith('system:'));
      if (recipients.length > MAX_RECIPIENTS)
        throw new Error(
          `notifyMany() takes at most ${MAX_RECIPIENTS} recipients in one notification.`,
        );
      prepared.push({
        input,
        recipients,
        key: input.key ?? (declaration.collapse ? `type:${input.type}` : null),
        data,
        ids: [],
      });
    }
    const locks = [
      ...new Set(
        prepared.flatMap(({ recipients, key }) =>
          key
            ? recipients.map(
                (recipient) => `${tenantId ?? ''}:${recipient}:${key}`,
              )
            : [],
        ),
      ),
    ];
    if (locks.length)
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(lock_key)) from unnest(array[${sql.join(
          locks.map((key) => sql`${key}::text`),
          sql`, `,
        )}]) as locks(lock_key)`,
      );
    const collapsing = prepared.flatMap(({ recipients, key }) =>
      key ? recipients.map((recipient) => ({ recipient, key })) : [],
    );
    const old = collapsing.length
      ? await tx
          .delete(notifications)
          .where(
            and(
              tenantId
                ? eq(notifications.tenantId, tenantId)
                : isNull(notifications.tenantId),
              or(
                ...collapsing.map(({ recipient, key }) =>
                  and(
                    eq(notifications.recipient, recipient),
                    eq(notifications.key, key),
                  ),
                ),
              ),
            ),
          )
          .returning({
            recipient: notifications.recipient,
            key: notifications.key,
            count: notifications.count,
          })
      : [];
    const counts = new Map(
      old.map((row) => [`${row.recipient}\u0000${row.key}`, row.count]),
    );
    const owners = prepared.flatMap((item) => item.recipients.map(() => item));
    const values = prepared.flatMap((item) =>
      item.recipients.map((recipient) => ({
        recipient,
        type: item.input.type,
        data: item.data,
        key: item.key,
        count: item.key
          ? (counts.get(`${recipient}\u0000${item.key}`) ?? 0) + 1
          : 1,
        link: item.input.link ?? null,
      })),
    );
    if (!values.length) return prepared.map((item) => item.ids);
    // The ids are the column's uuidv7(), time-ordered: the list is newest
    // first by id (#849). A multi-row INSERT returns its rows in the order
    // of its VALUES.
    const rows = await tx
      .insert(notifications)
      .values(values)
      .returning({ id: notifications.id });
    rows.forEach((row, index) => owners[index]!.ids.push(row.id));
    const messages: NewOutboxMessage<NotificationMessage>[] = values.map(
      (row, index) => ({
        topic: NOTIFICATIONS_TOPIC,
        key: null, // no ordering key, as in notify()
        payload: {
          notificationId: rows[index]!.id,
          recipient: row.recipient,
          type: row.type,
          tenantId,
        },
      }),
    );
    await this.outbox.add(tx, messages);
    return prepared.map((item) => item.ids);
  }

  /**
   * A test notification to the caller (`system.test`, development only: the
   * route and the type are left out elsewhere), through the normal path:
   * stored, then delivered by the worker to every channel the caller has on.
   */
  async sendTest(principal: Principal) {
    const [id] = await inTransaction(this.txHost, (tx) =>
      this.notify(tx, {
        type: 'system.test',
        to: principal,
        data: { at: new Date().toISOString() },
      }),
    );
    this.deliverNow();
    return { id: id! };
  }

  /** Wakes the outbox relay: call after the transaction that notified committed. */
  deliverNow() {
    this.outbox.notify();
  }

  /** A page of the caller's notifications, newest first, the texts in `locale` (default: the request's). */
  async page(principal: Principal, query: ListQuery, locale?: string) {
    const where = and(
      eq(notifications.recipient, principalKey(principal)),
      tenantPredicate(notifications.tenantId, { includeNullRows: true }),
      shownTo(principal),
      NOTIFICATION_LIST.where(query),
    );
    const [rows, total] = await Promise.all([
      this.db
        .select()
        .from(notifications)
        .where(and(where, afterCursor(notifications.id, query)))
        .orderBy(...pageOrder(notifications.id, query))
        .limit(query.limit + 1)
        .offset(pageOffset(query)),
      countPage(this.db, notifications, where, query),
    ]);
    const page = toPage(rows, query, total);
    return { ...page, items: page.items.map((row) => this.view(row, locale)) };
  }

  /** A stored notification as the API shows it, the texts in `locale` (default: the request's). */
  view(row: Notification, locale?: string): NotificationView {
    const { title, body } = this.catalog.render(
      row.type,
      row.data,
      row.count,
      locale,
    );
    return {
      id: row.id,
      type: row.type,
      title,
      body,
      data: row.data,
      link: row.link,
      key: row.key,
      count: row.count,
      read: row.readAt !== null,
      readAt: row.readAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async unreadCount(principal: Pick<Principal, 'kind' | 'id'>) {
    // Capped, as countPage does: an exact count reads every unread row.
    const unread = this.db
      .select({ one: sql`1` })
      .from(notifications)
      .where(
        and(
          eq(notifications.recipient, principalKey(principal)),
          tenantPredicate(notifications.tenantId, { includeNullRows: true }),
          shownTo(principal),
          isNull(notifications.readAt),
        ),
      )
      .limit(UNREAD_COUNT_CAP + 1)
      .as('unread');
    const [row] = await this.db.select({ rows: count() }).from(unread);
    const rows = row?.rows ?? 0;
    return rows > UNREAD_COUNT_CAP
      ? { unread: UNREAD_COUNT_CAP, unreadCapped: true }
      : { unread: rows, unreadCapped: false };
  }

  /**
   * How many notifications the worker has not delivered, though older than
   * ten minutes: the number to alert on. Those the context can see: in a
   * request, its tenant's and the accounts' own.
   */
  async undelivered() {
    const [row] = await this.db
      .select({ undelivered: sql<number>`count(*)::int` })
      .from(notifications)
      .where(
        and(
          isNull(notifications.deliveredAt),
          lt(notifications.createdAt, new Date(Date.now() - 10 * 60_000)),
        ),
      );
    return { undelivered: row?.undelivered ?? 0 };
  }

  /** The caller's notification, or a 404. */
  async find(principal: Principal, id: string): Promise<Notification> {
    const [row] = await this.db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.id, id),
          eq(notifications.recipient, principalKey(principal)),
          shownTo(principal),
        ),
      );
    if (!row) {
      throw new NotFoundException(`Notification ${id} not found.`);
    }
    return row;
  }

  /** Marks one read (again: no change); the caller's connections hear `notification.read`. */
  async markRead(principal: Principal, id: string) {
    const found = await this.find(principal, id);
    if (found.readAt) {
      return this.view(found);
    }
    const [row] = await this.db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(and(eq(notifications.id, id), isNull(notifications.readAt)))
      .returning();
    const item = this.view(row ?? found);
    this.realtime.toPrincipal(principal, NOTIFICATION_EVENTS.read, {
      id: item.id,
      readAt: item.readAt,
    });
    await this.announceUnread(principal);
    return item;
  }

  /**
   * Marks the recipient's unread notifications of `type` read, in `tx` (the
   * change that settles them): IAM_NOTIFIER's settle(). The caller then
   * runs announceUnread() after the commit.
   */
  async settle(tx: Transaction, input: { type: string; to: string }) {
    await tx
      .update(notifications)
      .set({ readAt: new Date() })
      .where(
        and(
          eq(notifications.recipient, input.to),
          eq(notifications.type, input.type),
          isNull(notifications.readAt),
        ),
      );
  }

  /** Tells the recipient's connections their unread count (after a change to it). */
  async announceUnread(recipient: Pick<Principal, 'kind' | 'id'>) {
    this.realtime.toPrincipal(
      recipient,
      NOTIFICATION_EVENTS.unreadCount,
      await this.unreadCount(recipient),
    );
  }

  /**
   * Marks every unread one read (those created before `before`, when given);
   * how many changed. Works in batches of `READ_ALL_BATCH`, each committing
   * on its own: a failure part-way leaves some rows read, which is harmless
   * and idempotent.
   */
  async markAllRead(principal: Principal, before?: Date) {
    const now = new Date();
    let updated = 0;
    for (;;) {
      const batch = this.db
        .select({ id: notifications.id })
        .from(notifications)
        .where(
          and(
            eq(notifications.recipient, principalKey(principal)),
            isNull(notifications.readAt),
            before ? lt(notifications.createdAt, before) : undefined,
          ),
        )
        .limit(READ_ALL_BATCH);
      const result = await this.db
        .update(notifications)
        .set({ readAt: now })
        .where(
          and(inArray(notifications.id, batch), isNull(notifications.readAt)),
        );
      // Database's portable result type is unknown; node-postgres reports rowCount.
      const changed = (result as { rowCount?: number | null }).rowCount ?? 0;
      updated += changed;
      if (changed < READ_ALL_BATCH) break;
    }
    if (updated > 0) {
      this.realtime.toPrincipal(principal, NOTIFICATION_EVENTS.readAll, {
        before: before?.toISOString() ?? null,
        updated,
      });
      await this.announceUnread(principal);
    }
    return { updated };
  }

  async remove(principal: Principal, id: string) {
    const deleted = await this.db
      .delete(notifications)
      .where(
        and(
          eq(notifications.id, id),
          eq(notifications.recipient, principalKey(principal)),
        ),
      )
      .returning({ id: notifications.id });
    if (deleted.length === 0) {
      throw new NotFoundException(`Notification ${id} not found.`);
    }
    this.realtime.toPrincipal(principal, NOTIFICATION_EVENTS.removed, { id });
    await this.announceUnread(principal);
  }

  /** The declared types as this caller sees them: label, whether mandatory, the defaults of their channels. */
  types(principal: Principal, locale?: string) {
    const settable = this.catalog.settable(principal);
    return this.catalog.declarations().map((declaration) => ({
      type: declaration.type,
      label: this.catalog.label(declaration.type, locale),
      mandatory: declaration.mandatory === true,
      urgent: declaration.urgent === true,
      channels: Object.fromEntries(
        settable.map((name) => [
          name,
          (declaration.channels as Record<string, unknown> | undefined)?.[
            name
          ] ?? false,
        ]),
      ),
    }));
  }

  /** A recipient's stored overrides (empty when none). */
  async overrides(recipient: string): Promise<PreferenceOverrides> {
    const [row] = await this.db
      .select({ settings: notificationPreferences.settings })
      .from(notificationPreferences)
      .where(eq(notificationPreferences.recipient, recipient));
    return row?.settings ?? {};
  }

  /** A recipient's quiet hours, or null. */
  async quietHoursOf(recipient: string): Promise<QuietHours | null> {
    const [row] = await this.db
      .select({ quietHours: notificationPreferences.quietHours })
      .from(notificationPreferences)
      .where(eq(notificationPreferences.recipient, recipient));
    return row?.quietHours ?? null;
  }

  /** The caller's quiet hours with the time zone their clock follows (theirs, else the deployment's). */
  async quietHours(principal: UserPrincipal) {
    const quiet = await this.quietHoursOf(principalKey(principal));
    return {
      quietHours: quiet
        ? {
            ...quiet,
            timezone:
              principal.timezone ??
              this.config.get('APP_TIMEZONE', { infer: true }),
          }
        : null,
    };
  }

  /** Sets (or, with null, clears) the caller's quiet hours. Audited. */
  async setQuietHours(
    principal: UserPrincipal,
    quiet: QuietHours | null,
    ip?: string,
  ) {
    const recipient = principalKey(principal);
    await inTransaction(this.txHost, async (tx) => {
      const from = await this.quietHoursOf(recipient);
      await tx
        .insert(notificationPreferences)
        .values({ recipient, quietHours: quiet })
        .onConflictDoUpdate({
          target: notificationPreferences.recipient,
          set: { quietHours: quiet },
        });
      await this.audit.record(
        principal,
        {
          action: 'notificationQuietHours.updated',
          targetType: 'notificationPreferences',
          targetId: recipient,
          details: { from, to: quiet },
          ip,
        },
        tx,
      );
    });
    return this.quietHours(principal);
  }

  /** The caller's effective settings, per type, for the channels they may set. */
  async preferences(principal: Principal) {
    const overrides = await this.overrides(principalKey(principal));
    return this.effective(principal, overrides);
  }

  /**
   * Replaces the caller's overrides with `raw`, checked against the
   * declared types and their channels (a 400 naming `<type>.<channel>`;
   * a mandatory type can't be switched off). Audited with what changed.
   */
  async updatePreferences(principal: Principal, raw: unknown, ip?: string) {
    const parsed = this.catalog.preferencesSchema(principal).safeParse(raw);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'validation_failed',
        message: 'The preferences are invalid.',
        errors: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }
    const recipient = principalKey(principal);
    // Only what was set: a type or channel left out keeps its default.
    const settings: PreferenceOverrides = {};
    for (const [type, channels] of Object.entries(parsed.data)) {
      const given = Object.fromEntries(
        Object.entries(channels ?? {}).filter(
          ([, value]) => value !== undefined,
        ),
      );
      if (Object.keys(given).length > 0) settings[type] = given;
    }
    await inTransaction(this.txHost, async (tx) => {
      const from = await this.overrides(recipient);
      await tx
        .insert(notificationPreferences)
        .values({ recipient, settings })
        .onConflictDoUpdate({
          target: notificationPreferences.recipient,
          set: { settings },
        });
      await this.audit.record(
        principal,
        {
          action: 'notificationPreferences.updated',
          targetType: 'notificationPreferences',
          targetId: recipient,
          details: { from, to: settings },
          ip,
        },
        tx,
      );
    });
    return this.effective(principal, settings);
  }

  private effective(principal: Principal, overrides: PreferenceOverrides) {
    return {
      types: Object.fromEntries(
        this.catalog
          .declarations()
          .map((declaration) => [
            declaration.type,
            this.catalog.effective(
              declaration,
              overrides[declaration.type],
              principal,
            ),
          ]),
      ),
    };
  }
}

/**
 * What of a recipient's notifications this principal is shown: all of
 * them, but to an administrator acting as the person (impersonation): then
 * only the tenant's, never the account's own (security notifications: the
 * person's, across their tenants).
 */
function shownTo(principal: Pick<Principal, 'kind' | 'id'>) {
  return (principal as { impersonator?: unknown }).impersonator
    ? isNotNull(notifications.tenantId)
    : undefined;
}
