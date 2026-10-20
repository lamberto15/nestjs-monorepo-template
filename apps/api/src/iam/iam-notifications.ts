import { z } from 'zod';
import type { Transaction } from '../core/database/drizzle.js';

/**
 * What IAM tells people about their own account's security (texts:
 * `i18n/<locale>/notifications.json`, under `security`). All mandatory:
 * the recipient may change when the mail goes, never switch it off.
 * Handed to the platform in app.module.ts
 * (`PlatformModule.forRoot({ notifications: [...IAM_NOTIFICATIONS, …] })`),
 * which checks them like any other declaration.
 *
 * Plain declarations, not `defineNotifications()`: IAM doesn't import the
 * platform (core ← iam ← platform). The platform sends them through
 * `IAM_NOTIFIER`.
 */
export const IAM_NOTIFICATIONS = [
  {
    // A password sign-in from a device the account hasn't used in 30 days (SecurityAlertsService).
    type: 'security.newSignIn',
    channels: { email: 'immediate' },
    mandatory: true,
    data: z.object({
      device: z.string(),
      ip: z.string(),
      at: z.iso.datetime(),
    }),
  },
  {
    // Changed by the user, or set with a reset link.
    type: 'security.passwordChanged',
    channels: { email: 'immediate' },
    mandatory: true,
    data: z.object({ via: z.enum(['change', 'reset']), ip: z.string() }),
  },
  {
    // The password of a sign-in is in a known data breach (SignInPasswordCheck):
    // once per password per PASSWORD_BREACH_RECHECK_DAYS, until it's changed.
    type: 'security.passwordBreached',
    channels: { email: 'immediate' },
    mandatory: true,
    data: z.object({ at: z.iso.datetime(), ip: z.string() }),
  },
  {
    // Two-factor turned on (enrollment confirmed) or off.
    type: 'security.mfaChanged',
    channels: { email: 'immediate' },
    mandatory: true,
    data: z.object({ enabled: z.boolean(), ip: z.string() }),
  },
  {
    // A passkey registered (PasskeysService): a new way into the account.
    type: 'security.passkeyAdded',
    channels: { email: 'immediate' },
    mandatory: true,
    data: z.object({ name: z.string(), ip: z.string() }),
  },
  {
    // A passkey removed (PasskeysService).
    type: 'security.passkeyRemoved',
    channels: { email: 'immediate' },
    mandatory: true,
    data: z.object({ name: z.string(), ip: z.string() }),
  },
  {
    // To the API client itself: a new key, and when its previous keys stop working.
    type: 'security.apiKeyRotated',
    channels: { webhook: true },
    mandatory: true,
    data: z.object({
      clientId: z.uuid(),
      keyId: z.string(),
      previousKeysEnd: z.iso.datetime(),
    }),
  },
  {
    // To each administrator of a tenant an operator opened with a
    // break-glass grant (BreakGlassService): who, why, until when.
    type: 'security.breakGlassStarted',
    channels: { email: 'immediate' },
    mandatory: true,
    data: z.object({
      operator: z.string(),
      reason: z.string(),
      expiresAt: z.iso.datetime(),
      ip: z.string(),
    }),
  },
] as const;

export type IamNotificationType = (typeof IAM_NOTIFICATIONS)[number]['type'];

/**
 * How IAM sends its notifications without importing the platform: the
 * platform provides this token (its NotificationsService). Absent, IAM
 * sends nothing.
 */
export const IAM_NOTIFIER = Symbol('IAM_NOTIFIER');

export interface IamNotifier {
  /** Stores the notification in `tx`, the change's transaction. */
  notify(
    tx: Transaction,
    input: {
      type: IamNotificationType;
      to: string;
      data: Record<string, unknown>;
      key?: string;
      /** Where to go about it: a path of the web app. */
      link?: string;
    },
  ): Promise<unknown>;
  /**
   * Marks the unread notifications of `type` for `to` (a principal key) read,
   * in `tx`: the news is settled, e.g. a breached password that was changed.
   */
  settle(
    tx: Transaction,
    input: { type: IamNotificationType; to: string },
  ): Promise<unknown>;
  /** After the commit: tells the recipient's connections their unread count. */
  announceUnread(recipient: { kind: 'user'; id: string }): Promise<unknown>;
  /** After the commit: skip the relay's poll. */
  deliverNow(): void;
}
