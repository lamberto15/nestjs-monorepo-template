import type { I18nService } from '@nestjs/i18n';
import type { z } from 'zod';
import type { Transaction } from '../../core/database/drizzle.js';
import type { TenantEnvelope } from '../../core/tenancy/tenant-job.js';
import type { Principal } from '../../iam/auth/principal.js';
import type { notifications } from './notifications.tables.js';

/** A stored notification: a row of `notifications`. */
export type Notification = typeof notifications.$inferSelect;

/** When the email channel sends: at once, or bundled into a digest. */
export type EmailMode = 'immediate' | 'hourly' | 'daily';
export type DigestMode = Exclude<EmailMode, 'immediate'>;

/**
 * What each channel's setting holds, for a type's defaults and a
 * recipient's preferences. A feature that adds a channel augments it:
 *
 * ```ts
 * declare module '…/platform/notifications/notification.types.js' {
 *   interface NotificationChannelSettings { sms: boolean }
 * }
 * ```
 */
export interface NotificationChannelSettings {
  /** Users only: `false`, or when the mail goes. */
  email: EmailMode | false;
  /** API clients only: the `notification.created` webhook. */
  webhook: boolean;
}

/**
 * A notification type, as its catalog entry names it: `note.published` is
 * `notifications.note.published.{label,title,body}` in
 * `src/i18n/<locale>/notifications.json`. A type the English catalog
 * doesn't name fails to compile. (No segment of a type is named `label`.)
 */
type LabelKey = Extract<
  Parameters<I18nService['t']>[0],
  `notifications.${string}.label`
>;
export type NotificationType = LabelKey extends `notifications.${infer T}.label`
  ? T
  : never;

/**
 * A notification type a feature declares (`defineNotifications()`), handed
 * to the platform in `app.module.ts`:
 *
 * ```ts
 * export const NOTE_NOTIFICATIONS = defineNotifications([
 *   { type: 'note.published', channels: { email: 'immediate', webhook: true }, data: z.object({ noteId: z.uuid(), title: z.string() }) },
 * ]);
 * PlatformModule.forRoot({ …, notifications: [...NOTE_NOTIFICATIONS] })
 * ```
 *
 * In-app (the stored notification) and realtime are always on; the other
 * channels take their defaults from `channels`, which the recipient may
 * change in their preferences.
 */
export interface NotificationTypeDeclaration<
  D extends Record<string, unknown> = Record<string, unknown>,
> {
  type: NotificationType;
  /** Each channel's default; a channel left out is off. */
  channels?: Partial<NotificationChannelSettings>;
  /** The recipient may change a channel's frequency, never switch it off. */
  mandatory?: boolean;
  /** `notify()` without a `key` collapses on the type: one row per recipient, counted up. */
  collapse?: boolean;
  /** Checked by `notify()`; its keys are the placeholders of the title and body. */
  data?: z.ZodType<D>;
}

export const defineNotifications = <
  const T extends readonly NotificationTypeDeclaration<any>[],
>(
  types: T,
) => types;

/** A recipient's overrides of the types' defaults: `{ [type]: { [channel]: value } }`. */
export type PreferenceOverrides = Record<string, Record<string, unknown>>;

/** One delivery: the notification, who gets it, what the channel is set to, the texts in their language. */
export interface NotificationDelivery {
  notification: Notification;
  /** The recipient as they are now (active). */
  recipient: Principal;
  /** The channel's effective setting for this recipient and type. */
  setting: unknown;
  rendered: { locale: string; title: string; body: string };
}

/**
 * A way to reach a recipient. The platform ships realtime, email and
 * webhook; a feature adds one as a provider that registers itself:
 *
 * ```ts
 * @Injectable()
 * export class SmsChannel implements NotificationChannel<boolean> {
 *   readonly name = 'sms';
 *   readonly settings = { schema: z.boolean(), off: false };
 *   constructor(registry: NotificationChannelRegistry) { registry.register(this); }
 *   supports(recipient) { return recipient.kind === 'user'; }
 *   async afterCommit({ recipient, rendered }) { … }
 * }
 * ```
 *
 * The delivery handler calls `inTransaction` inside the transaction that
 * records the delivery (effects that must commit with it: a webhook through
 * the outbox, a digest flag), then `afterCommit` (effects that can't roll
 * back: a socket emit). A channel without `settings` is always on and not a
 * preference (realtime).
 */
export interface NotificationChannel<S = unknown> {
  readonly name: string;
  /** What a preference may hold, and the value that means off. */
  readonly settings?: { schema: z.ZodType<S>; off: S };
  /** Whether this kind of recipient can be reached (email: users; webhook: clients). */
  supports(recipient: Principal): boolean;
  inTransaction?(
    delivery: NotificationDelivery,
    tx: Transaction,
  ): Promise<void>;
  afterCommit?(delivery: NotificationDelivery): Promise<void>;
}

/** The outbox topic a notification travels on, from the caller's commit to the delivery handler. */
export const NOTIFICATIONS_TOPIC = 'notifications.deliver';
/** The webhook event an API client recipient gets. */
export const NOTIFICATION_WEBHOOK_EVENT = 'notification.created';
/**
 * The realtime events the recipient's every connection gets, so a badge
 * and a list stay right across tabs: a new notification (the item), one
 * read, all read up to a moment, one removed, and the unread count after
 * each of them.
 */
export const NOTIFICATION_EVENTS = {
  created: 'notification',
  read: 'notification.read',
  readAll: 'notifications.read-all',
  removed: 'notification.removed',
  unreadCount: 'notifications.unread-count',
} as const;

/**
 * What the outbox carries per recipient, with the tenant the notification
 * was stored in (TenantEnvelope: null for an account's own, sent outside
 * any tenant): the delivery runs in it (docs/tenancy.md).
 */
export interface NotificationMessage extends TenantEnvelope {
  notificationId: string;
  recipient: string;
  type: string;
}
