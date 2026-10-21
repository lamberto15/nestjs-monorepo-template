import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import { PasswordHasher } from '@nestjs/authentication';
import { TransactionHost } from '@nestjs-cls/transactional';
import { t } from '@nestjs/i18n';
import { desc, eq, inArray } from 'drizzle-orm';
import {
  database,
  type DrizzleTransactions,
} from '../../core/database/transactions.js';
import { AuthPolicyService } from '../auth/auth-policy.service.js';
import { passwordHistory, users } from '../iam.tables.js';
import { PasswordHashLimiter } from './password-hashing.js';

/**
 * `auth.passwordHistory` (docs/auth.md, "Passwords"): a new password may
 * not repeat one of the account's last N (the current one counts), N being
 * the strictest of its tenants' choices, 0 (the default) off.
 *
 * Only hashes are kept, from the account's own hasher (the table holds the
 * hashes the current password's column held before), and only while some
 * tenant of the account asks for a history: with N = 0 a replaced hash is
 * dropped with the rest of the account's history, so turning it off leaves
 * nothing behind at the next change.
 *
 * Custom code: @nestjs/authentication has no password history.
 */
@Injectable()
export class PasswordHistoryService {
  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly hasher: PasswordHasher,
    private readonly limiter: PasswordHashLimiter,
    private readonly authPolicy: AuthPolicyService,
  ) {}

  private get db() {
    return database(this.txHost);
  }

  /**
   * How many passwords the account may not repeat (`auth.passwordHistory`,
   * the strictest of its tenants'), 0 off. Read before the transaction that
   * calls `replaced()`: a tenant's settings can't be read from inside one
   * for no tenant (a reset link has none).
   */
  count(userId: string) {
    return this.authPolicy.passwordHistory({ userId });
  }

  /**
   * A 422 `password_reused` (on the field `path`) when the password is the
   * account's current one or one of the previous N - 1. Each comparison is a
   * scrypt verification; they run in one hashing slot, one after the other
   * (an N-wide burst per request would starve the sign-ins), so a full
   * hashing queue answers 503 `server_busy` as everywhere else, before
   * anything is spent. Off, or an account without a password: no hashing.
   */
  async assertNotReused(userId: string, password: string, path: string) {
    const count = await this.count(userId);
    if (count === 0) {
      return;
    }
    const [current] = await this.db
      .select({ passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, userId));
    const previous = await this.db
      .select({ passwordHash: passwordHistory.passwordHash })
      .from(passwordHistory)
      .where(eq(passwordHistory.userId, userId))
      .orderBy(desc(passwordHistory.createdAt), desc(passwordHistory.id))
      .limit(count - 1);
    const hashes = [
      current?.passwordHash,
      ...previous.map((p) => p.passwordHash),
    ].filter((hash): hash is string => !!hash);
    if (hashes.length === 0) {
      return;
    }
    const reused = await this.limiter.run(async () => {
      for (const hash of hashes) {
        if (await this.hasher.verify(password, hash)) {
          return true;
        }
      }
      return false;
    });
    if (reused) {
      const message = t('auth.passwordReused', { args: { count } });
      throw new UnprocessableEntityException({
        code: 'password_reused',
        message,
        history: count,
        errors: [{ path, message }],
      });
    }
  }

  /**
   * In the caller's transaction, before the password changes: keeps the hash
   * being replaced (the account's current one) and prunes the history to the
   * N - 1 newest (`count`, from `count()`). Off (N = 0, or 1: only the
   * current password counts): keeps nothing and drops what was kept.
   */
  async replaced(userId: string, count: number) {
    const keep = Math.max(0, count - 1);
    if (keep === 0) {
      await this.db
        .delete(passwordHistory)
        .where(eq(passwordHistory.userId, userId));
      return;
    }
    const [current] = await this.db
      .select({ passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, userId));
    if (current?.passwordHash) {
      await this.db
        .insert(passwordHistory)
        .values({ userId, passwordHash: current.passwordHash });
    }
    const kept = await this.db
      .select({ id: passwordHistory.id })
      .from(passwordHistory)
      .where(eq(passwordHistory.userId, userId))
      .orderBy(desc(passwordHistory.createdAt), desc(passwordHistory.id));
    const stale = kept.slice(keep).map((row) => row.id);
    if (stale.length > 0) {
      await this.db
        .delete(passwordHistory)
        .where(inArray(passwordHistory.id, stale));
    }
  }
}
