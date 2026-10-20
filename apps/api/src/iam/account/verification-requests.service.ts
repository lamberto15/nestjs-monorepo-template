import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
} from '@nestjs/common';
import { EmailVerificationService } from '@nestjs/authentication';
import type { Redis } from 'ioredis';
import { REDIS } from '../../core/redis/redis.js';
import { normalizeEmail, UsersRepository } from '../auth/users.repository.js';

/** At most one link per account in this long through the public resend. */
export const VERIFICATION_RESEND_COOLDOWN_MS = 60_000;

/**
 * "Send the verification link again" for someone who is not signed in: a
 * password sign-up has no session until its address is proved, so the
 * signed-in resend is out of its reach (docs/auth.md, "Users").
 *
 * Shaped like @nestjs/authentication's `PasswordResetService.request()`
 * (forgot password): `request(email)` returns at once, before the account is
 * looked up; finding it, storing the link and queueing the mail happen after
 * the route answered, so neither the answer nor its timing says whether the
 * address has an account, or a verified one. The link goes to the address
 * the account has stored (EmailVerificationService.send()), through the mail
 * queue. Only an active account with a password whose address is unproved
 * gets one; at most one per VERIFICATION_RESEND_COOLDOWN_MS (the sign-up's
 * own link counts), so the route can't be used to flood a stranger's
 * mailbox from many addresses. The cooldown is taken atomically in Redis
 * (`SET verify-resend:<userId> NX PX`) before the link is made, so
 * concurrent requests, on any replica, send one; the links table is a
 * second guard, for the sign-up's own link.
 *
 * Custom: the package's EmailVerificationService only sends to a user the
 * app already holds (`send(user)`), with no request by address.
 */
@Injectable()
export class VerificationRequests implements OnModuleDestroy {
  private readonly logger = new Logger(VerificationRequests.name);
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly users: UsersRepository,
    private readonly emailVerification: EmailVerificationService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /** Starts a resend for `email`, if it has an unproved account; never throws, never waits. */
  request(email: string) {
    const requested = normalizeEmail(email);
    // The lookup runs once the route has answered (as the package's forgot password does).
    const work = new Promise<void>((resolve) => setImmediate(resolve))
      .then(() => this.issue(requested))
      .catch((error: unknown) =>
        this.logger.error(
          'A verification resend failed',
          error instanceof Error ? error.stack : error,
        ),
      );
    this.inFlight.add(work);
    void work.finally(() => this.inFlight.delete(work));
  }

  /** Resolves once the requests started so far are done (shutdown waits on it; so can a test). */
  async settled() {
    await Promise.all(this.inFlight);
  }

  async onModuleDestroy() {
    await this.settled();
  }

  private async issue(email: string) {
    const found = await this.users.findActiveByEmail(email);
    if (!found || found.user.emailVerified || !found.passwordHash) {
      return;
    }
    const since = new Date(Date.now() - VERIFICATION_RESEND_COOLDOWN_MS);
    if (await this.users.verificationLinkSentSince(found.user.id, since)) {
      return; // the sign-up's link, or a resend's, a moment ago
    }
    // Check-then-insert above races; this doesn't: one request per window wins.
    const taken = await this.redis.set(
      `verify-resend:${found.user.id}`,
      '1',
      'PX',
      VERIFICATION_RESEND_COOLDOWN_MS,
      'NX',
    );
    if (taken !== 'OK') {
      return;
    }
    await this.emailVerification.send(found.user);
  }
}
