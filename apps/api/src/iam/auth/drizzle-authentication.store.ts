import { Injectable, Optional } from '@nestjs/common';
import {
  AuthenticationStorage,
  type EmailTokenPurpose,
  type EmailTokenRecord,
  type EmailTokenStore,
  type MagicLinkRecord,
  type MagicLinkStore,
  type MfaStore,
  type OidcStateStore,
  type OidcTransaction,
  type RefreshTokenRecord,
  type RefreshTokenStore,
  type SessionRecord,
  type SessionStore,
  type TotpRecord,
} from '@nestjs/authentication';
import { TransactionHost } from '@nestjs-cls/transactional';
import { and, desc, eq, gt, isNull, lt, lte, or, sql } from 'drizzle-orm';
import {
  database,
  type DrizzleTransactions,
} from '../../core/database/transactions.js';
import {
  emailTokens,
  magicLinks,
  mfaAuthenticators,
  mfaFailures,
  mfaRecoveryCodes,
  oidcLogins,
  refreshTokens,
  sessions,
} from '../iam.tables.js';
import { UsersRepository } from './users.repository.js';
import { SessionLifecycleRegistry } from './session-lifecycle.registry.js';
import { distinctTokenSessionIds, tokenSessionId } from './token-session.js';

/**
 * Keeps sessions, refresh tokens, authenticators and pending links in
 * PostgreSQL, through Drizzle: the store of the NestJS authentication docs. Every method that decides whether something
 * works once is a single conditional statement, so the guarantees hold with
 * any number of API instances.
 *
 * Reads and writes go through the transaction host: inside a service's
 * `inTransaction()` (two-factor off with its audit entry and notification)
 * they are part of that transaction; outside one, each statement commits
 * by itself, as the package expects (`recordMfaFailure` relies on that).
 */
@Injectable()
export class DrizzleAuthenticationStore
  implements
    SessionStore,
    RefreshTokenStore,
    MfaStore,
    MagicLinkStore,
    OidcStateStore,
    EmailTokenStore
{
  /** Pending links and logins kept per table: anyone can create them. */
  protected readonly maxPending: number = 100_000;

  /** The current transaction, or the database outside one (core/database/transactions.ts). */
  private get db() {
    return database(this.txHost);
  }

  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly users: UsersRepository,
    storage: AuthenticationStorage,
    @Optional() private readonly sessionLifecycle?: SessionLifecycleRegistry,
  ) {
    storage.registerSource({
      sessions: this,
      refreshTokens: this,
      mfa: this,
      magicLinks: this,
      oidcStates: this,
      emailTokens: this,
    });
  }

  // Sessions

  async getSession(id: string): Promise<SessionRecord | undefined> {
    const [row] = await this.db
      .select()
      .from(sessions)
      .where(eq(sessions.id, id));
    return (
      row && {
        ...withoutNulls(row),
        // Before SessionService moves it forward (touchSession): a tenant's
        // idle timeout is judged on the activity before this request.
        extra: { previousActiveAt: row.lastActiveAt },
      }
    );
  }

  // Every new session (a sign-in by any method; a rotation copies its
  // metadata) acts in a tenant (docs/tenancy.md): the user's last chosen,
  // else the oldest membership, unless the caller named one (a switch, an
  // impersonation) or none (null).
  async createSession(record: SessionRecord): Promise<void> {
    if (record.metadata?.tenantId === undefined) {
      // In place: the caller's record (the issued session) shows it too.
      record.metadata = {
        ...record.metadata,
        tenantId: await this.users.defaultTenant(record.userId),
      };
    }
    await this.db.insert(sessions).values(record);
    await this.db
      .delete(sessions)
      .where(lte(sessions.expiresAt, record.createdAt));
  }

  async touchSession(id: string, lastActiveAt: Date): Promise<void> {
    // Conditional: a session deleted by a sign-out stays deleted.
    await this.db
      .update(sessions)
      .set({ lastActiveAt })
      .where(and(eq(sessions.id, id), lt(sessions.lastActiveAt, lastActiveAt)));
  }

  // Whether this call deleted it: of two rotations of a session, or a rotation and a sign-out, one wins.
  async deleteSession(id: string): Promise<boolean> {
    const deleted = await this.db
      .delete(sessions)
      .where(eq(sessions.id, id))
      .returning({ id: sessions.id });
    if (deleted[0] && this.sessionLifecycle) {
      await this.sessionLifecycle.afterRevocation(deleted[0].id);
    }
    return deleted.length > 0;
  }

  async listUserSessions(userId: string): Promise<SessionRecord[]> {
    const rows = await this.db
      .select()
      .from(sessions)
      .where(eq(sessions.userId, userId));
    return rows.map(withoutNulls);
  }

  async deleteUserSessions(userId: string): Promise<void> {
    const lifecycle = this.sessionLifecycle;
    const deleted = await this.db
      .delete(sessions)
      .where(eq(sessions.userId, userId))
      .returning({ id: sessions.id });
    if (lifecycle) {
      await Promise.all(deleted.map(({ id }) => lifecycle.afterRevocation(id)));
    }
  }

  // Refresh tokens

  async getRefreshToken(id: string): Promise<RefreshTokenRecord | undefined> {
    const [row] = await this.db
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.id, id));
    if (!row) {
      return undefined;
    }
    const { revoked: _, ...token } = row;
    return withoutNulls(token);
  }

  async saveRefreshToken(record: RefreshTokenRecord): Promise<void> {
    await this.db.insert(refreshTokens).values(record);
    await this.db
      .delete(refreshTokens)
      .where(lte(refreshTokens.familyExpiresAt, record.createdAt));
  }

  /**
   * When the family's first token was made (its sign-in) and its latest
   * (its last refresh): what a tenant's session limits are judged on
   * (SessionLifetime). Undefined: no such family.
   */
  async refreshTokenFamilyBounds(familyId: string) {
    const [row] = await this.db
      .select({
        first: sql<Date | null>`min(${refreshTokens.createdAt})`.mapWith(
          refreshTokens.createdAt,
        ),
        last: sql<Date | null>`max(${refreshTokens.createdAt})`.mapWith(
          refreshTokens.createdAt,
        ),
      })
      .from(refreshTokens)
      .where(eq(refreshTokens.familyId, familyId));
    return row?.first && row.last
      ? { first: row.first, last: row.last }
      : undefined;
  }

  async markRefreshTokenUsed(id: string, at: Date): Promise<boolean> {
    // Conditional: of two refreshes with the same token, one updates the row.
    const updated = await this.db
      .update(refreshTokens)
      .set({ usedAt: at })
      .where(and(eq(refreshTokens.id, id), isNull(refreshTokens.usedAt)))
      .returning({ id: refreshTokens.id });
    return updated.length === 1;
  }

  async revokeRefreshTokenFamily(familyId: string): Promise<void> {
    const revoked = await this.db
      .update(refreshTokens)
      .set({ revoked: true })
      .where(eq(refreshTokens.familyId, familyId))
      .returning({ sid: tokenSessionId });
    await this.afterTokenRevocation(revoked);
  }

  async isRefreshTokenFamilyRevoked(familyId: string): Promise<boolean> {
    const revoked = await this.db
      .select({ id: refreshTokens.id })
      .from(refreshTokens)
      .where(
        and(
          eq(refreshTokens.familyId, familyId),
          eq(refreshTokens.revoked, true),
        ),
      )
      .limit(1);
    return revoked.length > 0;
  }

  async revokeUserRefreshTokens(userId: string): Promise<void> {
    // The families still live: those revoked before have nothing left to end.
    const revoked = await this.db
      .update(refreshTokens)
      .set({ revoked: true })
      .where(
        and(eq(refreshTokens.userId, userId), eq(refreshTokens.revoked, false)),
      )
      .returning({ sid: tokenSessionId });
    await this.afterTokenRevocation(revoked);
  }

  /**
   * Whether the family whose access tokens carry this `sid` (tokenClaims())
   * was revoked. Not the package's: its access tokens live until they
   * expire, and requests don't ask. A realtime handshake does (Realtime),
   * since a socket outlives the access token that opened it.
   */
  async isTokenSessionRevoked(userId: string, sid: string): Promise<boolean> {
    const revoked = await this.db
      .select({ id: refreshTokens.id })
      .from(refreshTokens)
      .where(
        and(
          eq(refreshTokens.userId, userId),
          eq(refreshTokens.revoked, true),
          eq(tokenSessionId, sid),
        ),
      )
      .limit(1);
    return revoked.length > 0;
  }

  /** Tells the listeners (Realtime) which families' `sid`s just ended, once each. */
  private async afterTokenRevocation(rows: { sid: string | null }[]) {
    const lifecycle = this.sessionLifecycle;
    if (!lifecycle) {
      return;
    }
    await Promise.all(
      distinctTokenSessionIds(rows).map((sid) =>
        lifecycle.afterTokenRevocation(sid),
      ),
    );
  }

  // Authenticators, recovery codes and failed attempts

  async getTotp(userId: string): Promise<TotpRecord | undefined> {
    const [row] = await this.db
      .select()
      .from(mfaAuthenticators)
      .where(eq(mfaAuthenticators.userId, userId));
    if (!row) {
      return undefined;
    }
    const { userId: _, ...totp } = row;
    return withoutNulls(totp);
  }

  async saveTotp(userId: string, record: TotpRecord | null): Promise<void> {
    if (!record) {
      await this.db
        .delete(mfaAuthenticators)
        .where(eq(mfaAuthenticators.userId, userId));
      return;
    }
    const values = {
      secret: record.secret,
      confirmed: record.confirmed,
      pendingSecret: record.pendingSecret ?? null,
    };
    await this.db
      .insert(mfaAuthenticators)
      .values({ userId, ...values, lastUsedStep: record.lastUsedStep })
      .onConflictDoUpdate({
        target: mfaAuthenticators.userId,
        // Never lower the claimed step: the record may have been read before a claim.
        set: {
          ...values,
          lastUsedStep: sql`greatest(${mfaAuthenticators.lastUsedStep}, excluded.last_used_step)`,
        },
      });
  }

  async claimTotpStep(userId: string, step: number): Promise<boolean> {
    // Conditional: a code's time step is accepted once.
    const claimed = await this.db
      .update(mfaAuthenticators)
      .set({ lastUsedStep: step })
      .where(
        and(
          eq(mfaAuthenticators.userId, userId),
          or(
            isNull(mfaAuthenticators.lastUsedStep),
            lt(mfaAuthenticators.lastUsedStep, step),
          ),
        ),
      )
      .returning({ userId: mfaAuthenticators.userId });
    return claimed.length === 1;
  }

  async saveRecoveryCodes(userId: string, hashes: string[]): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .delete(mfaRecoveryCodes)
        .where(eq(mfaRecoveryCodes.userId, userId));
      if (hashes.length > 0) {
        await tx
          .insert(mfaRecoveryCodes)
          .values(
            [...new Set(hashes)].map((codeHash) => ({ userId, codeHash })),
          );
      }
    });
  }

  async consumeRecoveryCode(userId: string, hash: string): Promise<boolean> {
    // Conditional: of two requests with the same code, one deletes the row.
    const consumed = await this.db
      .delete(mfaRecoveryCodes)
      .where(
        and(
          eq(mfaRecoveryCodes.userId, userId),
          eq(mfaRecoveryCodes.codeHash, hash),
        ),
      )
      .returning({ userId: mfaRecoveryCodes.userId });
    return consumed.length === 1;
  }

  countRecoveryCodes(userId: string): Promise<number> {
    return this.db.$count(
      mfaRecoveryCodes,
      eq(mfaRecoveryCodes.userId, userId),
    );
  }

  async recordMfaFailure(
    userId: string,
    windowMs: number,
    now: number,
  ): Promise<number> {
    // Insert, then count, each committed on its own (no transaction): every attempt
    // counts itself and all those recorded before it.
    await this.db
      .insert(mfaFailures)
      .values({ userId, failedAt: new Date(now) });
    const failures = await this.countMfaFailures(userId, windowMs, now);
    await this.db
      .delete(mfaFailures)
      .where(lte(mfaFailures.failedAt, new Date(now - windowMs)));
    return failures;
  }

  countMfaFailures(
    userId: string,
    windowMs: number,
    now: number,
  ): Promise<number> {
    return this.db.$count(
      mfaFailures,
      and(
        eq(mfaFailures.userId, userId),
        gt(mfaFailures.failedAt, new Date(now - windowMs)),
      ),
    );
  }

  async clearMfaFailures(userId: string): Promise<void> {
    await this.db.delete(mfaFailures).where(eq(mfaFailures.userId, userId));
  }

  // Magic links

  async saveMagicLink(record: MagicLinkRecord): Promise<void> {
    await this.db.insert(magicLinks).values(record);
    await this.trim(magicLinks, record.createdAt);
  }

  async consumeMagicLink(id: string): Promise<MagicLinkRecord | undefined> {
    // DELETE … RETURNING: of two requests with the same link, one gets the row.
    const [row] = await this.db
      .delete(magicLinks)
      .where(eq(magicLinks.id, id))
      .returning();
    return row && withoutNulls(row);
  }

  // Sign-ins with Google in progress

  async saveOidcState({ link, ...login }: OidcTransaction): Promise<void> {
    await this.db.insert(oidcLogins).values({
      ...login,
      linkUserId: link?.userId,
      linkSessionId: link?.sessionId,
    });
    await this.trim(oidcLogins, login.createdAt);
  }

  async consumeOidcState(state: string): Promise<OidcTransaction | undefined> {
    const [row] = await this.db
      .delete(oidcLogins)
      .where(eq(oidcLogins.state, state))
      .returning();
    if (!row) {
      return undefined;
    }
    const { linkUserId, linkSessionId, ...login } = withoutNulls(row);
    return linkUserId && linkSessionId
      ? { ...login, link: { userId: linkUserId, sessionId: linkSessionId } }
      : login;
  }

  // Password reset and email verification links

  async saveEmailToken(record: EmailTokenRecord): Promise<void> {
    await this.db.insert(emailTokens).values(record);
    await this.trim(emailTokens, record.createdAt);
  }

  async consumeEmailToken(
    id: string,
    purpose: EmailTokenPurpose,
  ): Promise<EmailTokenRecord | undefined> {
    const [row] = await this.db
      .delete(emailTokens)
      .where(and(eq(emailTokens.id, id), eq(emailTokens.purpose, purpose)))
      .returning();
    return row && withoutNulls(row);
  }

  async deleteUserEmailTokens(
    userId: string,
    purpose: EmailTokenPurpose,
  ): Promise<void> {
    await this.db
      .delete(emailTokens)
      .where(
        and(eq(emailTokens.userId, userId), eq(emailTokens.purpose, purpose)),
      );
  }

  /** Deletes what expired, and past `maxPending`, what expires first. */
  private async trim(
    table: typeof magicLinks | typeof oidcLogins | typeof emailTokens,
    now: Date,
  ) {
    await this.db.delete(table).where(lte(table.expiresAt, now));
    const [cutoff] = await this.db
      .select({ expiresAt: table.expiresAt })
      .from(table)
      .orderBy(desc(table.expiresAt))
      .limit(1)
      .offset(this.maxPending);
    if (cutoff) {
      await this.db.delete(table).where(lte(table.expiresAt, cutoff.expiresAt));
    }
  }
}

/** A row without its NULL columns: the package's records leave optional fields out. */
type WithoutNulls<T> = {
  [K in keyof T as null extends T[K] ? never : K]: T[K];
} & {
  [K in keyof T as null extends T[K] ? K : never]?: Exclude<T[K], null>;
};

function withoutNulls<T extends object>(row: T): WithoutNulls<T> {
  return Object.fromEntries(
    Object.entries(row).filter(([, value]) => value !== null),
  ) as WithoutNulls<T>;
}
