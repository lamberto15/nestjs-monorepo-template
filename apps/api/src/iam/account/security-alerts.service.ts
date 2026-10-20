import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  Optional,
} from '@nestjs/common';
import { AuthenticationEvents } from '@nestjs/authentication';
import { TransactionHost } from '@nestjs-cls/transactional';
import { and, eq, gt, sql } from 'drizzle-orm';
import type { Transaction } from '../../core/database/drizzle.js';
import {
  type DrizzleTransactions,
  inTransaction,
} from '../../core/database/transactions.js';
import { AuditService } from '../audit/audit.service.js';
import { type UserPrincipal, principalKey } from '../auth/principal.js';
import { UsersRepository } from '../auth/users.repository.js';
import {
  IAM_NOTIFIER,
  type IamNotificationType,
  type IamNotifier,
} from '../iam-notifications.js';
import { auditLog } from '../iam.tables.js';
import { deviceOf, normalizeIp } from './devices.js';

/** A device unseen for this long is new again. */
const KNOWN_DEVICE_DAYS = 30;

/** The account's password sign-ins (audit_log_actor_action_at_idx). */
const signInsOf = (actor: string) =>
  and(eq(auditLog.actor, actor), eq(auditLog.action, 'auth.signed-in'));

/** A change to an account's credentials (or news about them: a breached password), as audited and told to its owner. */
export interface CredentialChange {
  /** The audit action (`auth.password-changed`). */
  action: string;
  ip: string;
  type:
    | 'security.passwordChanged'
    | 'security.passwordBreached'
    | 'security.mfaChanged'
    | 'security.passkeyAdded'
    | 'security.passkeyRemoved';
  /** The notification's data, without `ip` (added, normalized). */
  data: Record<string, unknown>;
  /** The audit entry's details (which passkey). */
  details?: Record<string, unknown>;
  /** Tell the owner only if the account was used before (an invitation's first password isn't news). */
  onlyIfUsed?: boolean;
  /** Where the notification leads: a path of the web app. */
  link?: string;
  /** Notifications of this type the change settles: marked read in the same transaction. */
  settles?: IamNotificationType;
}

/**
 * Tells a person about changes to their account's security
 * (IAM_NOTIFICATIONS): each notification is stored in the transaction of
 * the change and its audit entry, so it exists if and only if the change
 * was recorded. Sent through IAM_NOTIFIER (the platform's notifications);
 * without it, only the audit entries are written. Addresses are recorded
 * as people know them (`normalizeIp`).
 */
@Injectable()
export class SecurityAlertsService implements OnApplicationShutdown {
  private readonly logger = new Logger(SecurityAlertsService.name);
  /** The bookkeeping of sign-ins heard from the package (OIDC), still running. */
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly audit: AuditService,
    private readonly users: UsersRepository,
    private readonly tenancy: Tenancy,
    events: AuthenticationEvents,
    @Optional()
    @Inject(IAM_NOTIFIER)
    private readonly notifier?: IamNotifier,
  ) {
    // A sign-in the package completes by itself (the OIDC callback: the
    // provider's answer is turned into a session inside OidcService) has
    // no place in the app's code to call signedIn() from; its event does,
    // carrying what the session stores of the request (IamModule's
    // `session.metadata`: user agent and address).
    events.events$.subscribe((event) => {
      if (event.type === 'sign-in' && event.method?.startsWith('oidc:')) {
        this.track(
          this.heard(event.userId, event.method, {
            userAgent: event.metadata?.userAgent,
            ip: typeof event.metadata?.ip === 'string' ? event.metadata.ip : '',
          }),
        );
      }
    });
  }

  /**
   * A sign-in, by any method: audited (`auth.signed-in`, with the device's
   * hash and the method), and the user is told when the device is new: the
   * account signed in before, but not from this device (user agent without
   * versions + IPv4 address or IPv6 /64, see `deviceOf`) in the last 30
   * days. Repeats from one new device collapse into one notification (its
   * key), counted up. Delivered after the commit.
   */
  async signedIn(
    user: UserPrincipal,
    context: {
      userAgent: unknown;
      ip: string;
      /** `password`, `magic-link`, `oidc:google`, `passkey`. */
      method: string;
      /** A token client (`POST /auth/token`) rather than a browser session. */
      via?: 'token';
      /** More for the audit entry (which passkey, whether it verified its user). */
      details?: Record<string, unknown>;
    },
  ) {
    const device = deviceOf(context.userAgent, context.ip);
    const actor = principalKey(user);
    const since = new Date(Date.now() - KNOWN_DEVICE_DAYS * 86_400_000);
    // The account's own, in no tenant (docs/tenancy.md): a sign-in is to
    // the person, whichever tenant the session lands in, so its entry and
    // the new-device lookup read the account's rows of every sign-in, and
    // no tenant's administrator reads another person's sign-ins.
    const told = await this.tenancy.none(() =>
      inTransaction(this.txHost, async (tx) => {
        const [before] = await tx
          .select({ id: auditLog.id })
          .from(auditLog)
          .where(signInsOf(actor))
          .limit(1);
        const [known] = before
          ? await tx
              .select({ id: auditLog.id })
              .from(auditLog)
              .where(
                and(
                  signInsOf(actor),
                  gt(auditLog.at, since),
                  sql`${auditLog.details}->>'device' = ${device.hash}`,
                ),
              )
              .limit(1)
          : [];
        await this.audit.record(
          user,
          {
            action: 'auth.signed-in',
            ip: device.ip,
            details: {
              device: device.hash,
              userAgent: device.summary,
              method: context.method,
              ...(context.via && { via: context.via }),
              ...context.details,
            },
          },
          tx,
        );
        if (!before || known) {
          return false; // the first sign-in ever, or a known device
        }
        return this.alert(tx, 'security.newSignIn', actor, {
          data: {
            device: device.summary,
            ip: device.ip,
            at: new Date().toISOString(),
          },
          key: `security.newSignIn:${device.hash}`,
        });
      }),
    );
    if (told) {
      this.deliverNow();
    }
  }

  /**
   * A change to the credentials of `userId`'s account, in `tx` (the
   * change's transaction): its audit entry (by `actor`), and the owner's
   * notification. True when one was stored: call `deliverNow()` after the
   * commit.
   */
  async credentialsChanged(
    tx: Transaction,
    actor: UserPrincipal | null,
    userId: string,
    change: CredentialChange,
  ) {
    const to = principalKey({ kind: 'user', id: userId });
    const ip = normalizeIp(change.ip);
    // Before the entry below, which would count as a use.
    const used = !change.onlyIfUsed || (await this.hasBeenUsed(tx, to));
    await this.audit.record(
      actor,
      {
        action: change.action,
        targetType: 'user',
        targetId: userId,
        ...(change.details && { details: change.details }),
        ip,
      },
      tx,
    );
    if (change.settles && this.notifier) {
      await this.notifier.settle(tx, { type: change.settles, to });
    }
    return (
      used &&
      this.alert(tx, change.type, to, {
        data: { ...change.data, ip },
        ...(change.link && { link: change.link }),
      })
    );
  }

  /**
   * Whether the account did anything before (any audit entry as its actor,
   * within the log's retention): a sign-in of any kind, a profile change.
   * An invited account that never signed in has none.
   */
  async hasBeenUsed(tx: Transaction, actor: string) {
    const [found] = await tx
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(eq(auditLog.actor, actor))
      .limit(1);
    return found !== undefined;
  }

  /** Stores the notification in `tx`; false when nothing sends notifications. */
  async alert(
    tx: Transaction,
    type: IamNotificationType,
    to: string,
    input: { data: Record<string, unknown>; key?: string; link?: string },
  ) {
    if (!this.notifier) {
      return false;
    }
    await this.notifier.notify(tx, { type, to, ...input });
    return true;
  }

  /** After the commit: the notifications go now, not at the relay's next poll. */
  deliverNow() {
    this.notifier?.deliverNow();
  }

  /** After the commit of a change that `settles` notifications: the owner's connections hear the new unread count. */
  async announceSettled(userId: string) {
    await this.notifier?.announceUnread({ kind: 'user', id: userId });
  }

  /** The bookkeeping of sign-ins heard from the package, once done (tests, shutdown). */
  async settled() {
    await Promise.allSettled(this.inFlight);
  }

  async onApplicationShutdown() {
    await this.settled();
  }

  private async heard(
    userId: string,
    method: string,
    context: { userAgent: unknown; ip: string },
  ) {
    const user = await this.users.findActive(userId);
    if (user) {
      await this.signedIn(user, { ...context, method });
    }
  }

  /** Runs the bookkeeping of a heard sign-in; its failure is logged, never the sign-in's. */
  private track(work: Promise<void>) {
    const tracked = work
      .catch((error: unknown) =>
        this.logger.error('A sign-in was not recorded', {
          error: error instanceof Error ? error.message : String(error),
        }),
      )
      .finally(() => this.inFlight.delete(tracked));
    this.inFlight.add(tracked);
  }
}
