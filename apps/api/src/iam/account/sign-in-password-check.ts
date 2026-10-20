import { createHash } from 'node:crypto';
import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { Redis } from 'ioredis';
import {
  type DrizzleTransactions,
  inTransaction,
} from '../../core/database/transactions.js';
import { REDIS } from '../../core/redis/redis.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import type { UserPrincipal } from '../auth/principal.js';
import type { IamEnv } from '../iam.env.js';
import {
  BreachedPasswordsService,
  type HashRange,
  hashRange,
} from './breached-passwords.service.js';
import { SecurityAlertsService } from './security-alerts.service.js';

/**
 * The debounce key of one account's current password: its id and a short
 * SHA-256 of the stored scrypt hash. The hash is salted and changes with
 * every new password (and every rehash), so a new password is checked at
 * its first sign-in without anyone clearing anything, and the key says
 * nothing about the password (a digest of a salted, slow hash).
 */
export function recheckKey(userId: string, passwordHash: string) {
  const fingerprint = createHash('sha256')
    .update(passwordHash)
    .digest('base64url')
    .slice(0, 16);
  return `password-breach:${userId}:${fingerprint}`;
}

/** What a check of a sign-in's password came to. */
export type SignInCheckOutcome =
  /** PASSWORD_BREACH_CHECK=off. */
  | 'off'
  /** This password was checked within PASSWORD_BREACH_RECHECK_DAYS. */
  | 'recent'
  /** Not in the breaches (or seen fewer than PASSWORD_BREACH_MIN_COUNT times). */
  | 'clean'
  /** In the breaches: audited, and the owner told. */
  | 'breached'
  /** The API unreachable: nothing recorded, the next sign-in tries again. */
  | 'unknown';

/**
 * Sign-in passwords against the breach corpus (docs/auth.md, "Passwords"):
 * a password set before it appeared in a breach, or before the check
 * existed, is caught at the next sign-in. Never blocks or slows a sign-in:
 * after the password is verified, the check starts and the sign-in goes on
 * without waiting for it; whatever happens to it (the API down, Redis or
 * the database failing) is logged, never the sign-in's error. A breached
 * password is audited (`auth.password-breached`) and its owner told
 * (`security.passwordBreached`, mandatory: in-app and mail), once per
 * password per PASSWORD_BREACH_RECHECK_DAYS.
 *
 * Custom code, and not a queue job, on purpose: the range API needs the
 * password's SHA-1, and a job's payload would store that unsalted hash in
 * Redis (crackable for a weak password) until a worker ran it. Here the
 * plaintext is split at once (`hashRange`) and dropped; the suffix lives
 * only in this process's memory, for one HTTP call that waits on the
 * network (PASSWORD_BREACH_TIMEOUT_MS), not the CPU. What follows a
 * breach (the audit entry, the notification) goes through the outbox and
 * the mail queue like every security alert.
 */
@Injectable()
export class SignInPasswordCheck implements BeforeApplicationShutdown {
  private readonly logger = new Logger(SignInPasswordCheck.name);
  /** The checks still running (tests, shutdown). */
  private readonly inFlight = new Set<Promise<unknown>>();

  constructor(
    private readonly breached: BreachedPasswordsService,
    private readonly securityAlerts: SecurityAlertsService,
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly tenancy: Tenancy,
    private readonly config: ConfigService<IamEnv, true>,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /**
   * Starts the check of a password that was just verified, and returns at
   * once. `passwordHash` is the account's stored hash (after any rehash).
   */
  start(
    user: UserPrincipal,
    password: string,
    passwordHash: string,
    ip: string,
  ) {
    if (!this.breached.enabled) {
      return;
    }
    // The plaintext stops here: only its split SHA-1 goes on.
    const range = hashRange(password);
    const work = this.check(user, range, passwordHash, ip).catch(
      (error: unknown) => {
        this.logger.warn(
          `A sign-in's password was not checked against the breaches: ${
            error instanceof Error ? error.name : 'unknown error'
          }`,
        );
      },
    );
    const tracked = work.finally(() => this.inFlight.delete(tracked));
    this.inFlight.add(tracked);
  }

  /**
   * The check itself (start() runs it without waiting): skipped when this
   * password was checked within PASSWORD_BREACH_RECHECK_DAYS (one Redis
   * `SET NX EX`, so concurrent sign-ins check it once); a result the API
   * couldn't give releases the key, so the next sign-in tries again.
   */
  async check(
    user: UserPrincipal,
    range: HashRange,
    passwordHash: string,
    ip: string,
  ): Promise<SignInCheckOutcome> {
    if (!this.breached.enabled) {
      return 'off';
    }
    const key = recheckKey(user.id, passwordHash);
    const days = this.config.get('PASSWORD_BREACH_RECHECK_DAYS', {
      infer: true,
    });
    const claimed = await this.redis.set(key, '1', 'EX', days * 86_400, 'NX');
    if (claimed !== 'OK') {
      return 'recent';
    }
    const breached = await this.breached.isBreachedIn(range);
    if (breached === undefined) {
      await this.redis.del(key);
      return 'unknown';
    }
    if (!breached) {
      return 'clean';
    }
    await this.flag(user, ip);
    return 'breached';
  }

  /** The checks still running, once done (tests, shutdown). */
  async settled() {
    await Promise.allSettled(this.inFlight);
  }

  /** Before Redis and the database close (their onApplicationShutdown). */
  async beforeApplicationShutdown() {
    await this.settled();
  }

  /**
   * The audit entry and the owner's notification, in one transaction, in
   * no tenant: the account's own, like its sign-ins (docs/tenancy.md).
   */
  private async flag(user: UserPrincipal, ip: string) {
    const told = await this.tenancy.none(() =>
      inTransaction(this.txHost, (tx) =>
        this.securityAlerts.credentialsChanged(tx, user, user.id, {
          action: 'auth.password-breached',
          ip,
          type: 'security.passwordBreached',
          data: { at: new Date().toISOString() },
          // Where the mail's button and other clients lead.
          link: '/account/security',
        }),
      ),
    );
    if (told) {
      this.securityAlerts.deliverNow();
    }
  }
}
