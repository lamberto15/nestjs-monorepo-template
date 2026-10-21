import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import {
  database,
  type DrizzleTransactions,
} from '../../core/database/transactions.js';
import { createHash } from 'node:crypto';
import { and, asc, eq, gt, isNotNull, type SQL, sql } from 'drizzle-orm';
import {
  afterCursor,
  countMatching,
  pageOffset,
  pageOrder,
  type PageQuery,
  toPage,
} from '../../core/http/pagination.js';
import type { Database, Transaction } from '../../core/database/drizzle.js';
import { tenants } from '../../core/tenancy/tenancy.tables.js';
import {
  emailTokens,
  memberships,
  mfaAuthenticators,
  mfaFailures,
  mfaRecoveryCodes,
  passkeys,
  refreshTokens,
  sessions,
  userIdentities,
  users,
} from '../iam.tables.js';
import type { UserPrincipal } from './principal.js';

export interface UserView extends UserPrincipal {
  active: boolean;
  /** Whether the user has a password (an invited user has none until they set it). */
  hasPassword: boolean;
  createdAt: Date;
  updatedAt: Date;
}

type Row = typeof users.$inferSelect;
type Db = Database | Transaction;

/** Users accounts. Password hashes never leave this class but for verification. */
@Injectable()
export class UsersRepository {
  /** The current transaction, or the database outside one (core/database/transactions.ts). */
  private get db() {
    return database(this.txHost);
  }

  constructor(private readonly txHost: TransactionHost<DrizzleTransactions>) {}

  /**
   * The account as a principal acting in no tenant, or `null` when the
   * account is gone or deactivated. `inTenant()` for one that acts in one.
   */
  async findActive(id: string): Promise<UserPrincipal | null> {
    const [row] = await this.db.select().from(users).where(eq(users.id, id));
    return row?.active ? toPrincipal(row) : null;
  }

  /**
   * The signed-in principal in `tenantId` (a session's, a token's), or
   * `null` when the account is gone or deactivated, or when it acts in a
   * tenant it no longer may (the membership or the tenant deactivated):
   * that session or token stops, as a deactivated account's did, and a new
   * sign-in starts in a tenant the user still belongs to. Without a tenant
   * (an account with no membership yet), the principal has none: it can
   * list its tenants and switch, and every tenant route answers 403
   * tenant_required.
   */
  async inTenant(
    id: string,
    tenantId: string | null | undefined,
  ): Promise<UserPrincipal | null> {
    const user = await this.findActive(id);
    if (!user || !tenantId) {
      return user;
    }
    return (await this.isMember(id, tenantId)) ? { ...user, tenantId } : null;
  }

  /** Whether the user's membership in the tenant, and the tenant, are active. */
  async isMember(userId: string, tenantId: string): Promise<boolean> {
    if (!UUID.test(tenantId)) {
      return false;
    }
    const [row] = await this.db
      .select({ userId: memberships.userId })
      .from(memberships)
      .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
      .where(
        and(
          eq(memberships.userId, userId),
          eq(memberships.tenantId, tenantId),
          eq(memberships.active, true),
          eq(tenants.active, true),
        ),
      );
    return !!row;
  }

  /**
   * The tenants the user may act in (active memberships of active
   * tenants), the last chosen first, then the oldest: what a new sign-in
   * starts in, and what `GET /v1/auth/tenants` lists.
   */
  memberships(userId: string) {
    return this.db
      .select({
        id: tenants.id,
        slug: tenants.slug,
        name: tenants.name,
        selectedAt: memberships.selectedAt,
        joinedAt: memberships.createdAt,
      })
      .from(memberships)
      .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
      .where(
        and(
          eq(memberships.userId, userId),
          eq(memberships.active, true),
          eq(tenants.active, true),
        ),
      )
      .orderBy(
        sql`${memberships.selectedAt} desc nulls last`,
        asc(memberships.createdAt),
        asc(tenants.id),
      );
  }

  /** The tenant a new sign-in starts in: the last chosen, else the oldest membership; null without one. */
  async defaultTenant(userId: string): Promise<string | null> {
    if (!UUID.test(userId)) {
      return null; // not an account's id (the stores' contract tests use others)
    }
    const [first] = await this.memberships(userId);
    return first?.id ?? null;
  }

  /** Records that the user chose this tenant (a switch): the next sign-in starts there. */
  async selectTenant(userId: string, tenantId: string, db: Db = this.db) {
    await db
      .update(memberships)
      .set({ selectedAt: new Date() })
      .where(
        and(eq(memberships.userId, userId), eq(memberships.tenantId, tenantId)),
      );
  }

  /**
   * Removes the person from an account (their deletion, platform/account):
   * a placeholder address and name, no password, no sign-in methods
   * (providers, passkeys), sessions, tokens, roles or teams; deactivated. Their audit entries keep
   * the actor key (`user:<id>`), labelled "Deleted user" instead of the
   * address. The row stays: what references it (records they created)
   * keeps pointing at an account that is nobody's.
   */
  async anonymize(tx: Transaction, id: string) {
    await this.lockAccount(tx, id);
    await tx
      .update(users)
      .set({
        email: `deleted-${id}@anonymized.invalid`,
        name: DELETED_USER_NAME,
        passwordHash: null,
        emailVerified: false,
        locale: null,
        timezone: null,
        active: false,
        // Deleted, not deprovisioned: nothing brings it back.
        deprovisionedAt: null,
      })
      .where(eq(users.id, id));
    await tx.delete(userIdentities).where(eq(userIdentities.userId, id));
    await tx.delete(passkeys).where(eq(passkeys.userId, id));
    // Its roles and teams in every tenant go with the memberships (cascade).
    await tx.delete(memberships).where(eq(memberships.userId, id));
    await tx.delete(mfaAuthenticators).where(eq(mfaAuthenticators.userId, id));
    await tx.delete(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, id));
    await tx.delete(mfaFailures).where(eq(mfaFailures.userId, id));
    await tx.delete(sessions).where(eq(sessions.userId, id));
    await tx
      .update(refreshTokens)
      .set({ revoked: true })
      .where(eq(refreshTokens.userId, id));
  }

  /** The account as its owner sees it (`GET /v1/auth/me`): no tenant's view of it. */
  /** An account by its address, whatever its state: an administrator adding someone finds theirs. */
  async findByEmail(email: string, db: Db = this.db) {
    const [row] = await db
      .select()
      .from(users)
      .where(eq(users.email, normalizeEmail(email)));
    return row ? toView(row) : null;
  }

  /** Adds the user to the tenant (an active membership). */
  async addMembership(db: Db, tenantId: string, userId: string) {
    await db.insert(memberships).values({ tenantId, userId });
  }

  /** Makes the user an active member of the tenant: a new membership, or one deactivated before. */
  async joinTenant(db: Db, tenantId: string, userId: string) {
    await db
      .insert(memberships)
      .values({ tenantId, userId })
      .onConflictDoUpdate({
        target: [memberships.tenantId, memberships.userId],
        set: { active: true, updatedAt: new Date() },
      });
  }

  /**
   * The account's lock, until the transaction ends, and whether the account
   * is still active under it: its deletion (anonymize) and an invitation's
   * acceptance never interleave, so no membership outlives the account.
   */
  async lockAccount(tx: Transaction, userId: string) {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`account:${userId}`}, 0))`,
    );
    const [row] = await tx
      .select({ active: users.active })
      .from(users)
      .where(eq(users.id, userId));
    return row?.active === true;
  }

  /**
   * One change to a user's membership in a tenant at a time, until the
   * transaction ends: an invitation's acceptance and a deactivation never
   * interleave (both read and write the membership and its roles).
   */
  async lockMembership(tx: Transaction, tenantId: string, userId: string) {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`membership:${tenantId}:${userId}`}, 0))`,
    );
  }

  /** Activates or deactivates the user's membership in the tenant: their access to it, not their account. */
  async setMembershipActive(
    db: Db,
    tenantId: string,
    userId: string,
    active: boolean,
  ) {
    await db
      .update(memberships)
      .set({ active, updatedAt: new Date() })
      .where(
        and(eq(memberships.tenantId, tenantId), eq(memberships.userId, userId)),
      );
  }

  /**
   * Ends what acts in one tenant for the user (a membership deactivated):
   * the sessions in it and the token families issued for it. Their other
   * tenants' sessions and tokens go on.
   */
  async endTenantSessions(userId: string, tenantId: string, db: Db = this.db) {
    await db
      .delete(sessions)
      .where(
        and(
          eq(sessions.userId, userId),
          sql`${sessions.metadata}->>'tenantId' = ${tenantId}`,
        ),
      );
    await db
      .update(refreshTokens)
      .set({ revoked: true })
      .where(
        and(
          eq(refreshTokens.userId, userId),
          sql`${refreshTokens.claims}->>'tid' = ${tenantId}`,
        ),
      );
  }

  /**
   * After an identity provider's deprovisioning (SCIM) ended a membership:
   * deactivates the account when no active membership remains, in any
   * tenant (the owner's decision: deactivated, never deleted; its data,
   * audit history, holds and records stay). Every session and token family
   * of the account ends with it. Whether it was deactivated now.
   *
   * The caller holds the account's lock (`lockAccount`) and has written the
   * membership in `tx`: the memberships are read `for update`, so a
   * membership being turned on in another transaction (an administrator's,
   * another tenant's IdP) is waited for and counted, never missed.
   */
  async deactivateIfNoMembership(tx: Transaction, userId: string) {
    const rows = await tx
      .select({ active: memberships.active })
      .from(memberships)
      .where(eq(memberships.userId, userId))
      .for('update');
    if (rows.some((row) => row.active)) {
      return false;
    }
    const changed = await tx
      .update(users)
      .set({ active: false, deprovisionedAt: new Date() })
      .where(and(eq(users.id, userId), eq(users.active, true)))
      .returning({ id: users.id });
    if (!changed.length) {
      return false;
    }
    await tx.delete(sessions).where(eq(sessions.userId, userId));
    await tx
      .update(refreshTokens)
      .set({ revoked: true })
      .where(eq(refreshTokens.userId, userId));
    return true;
  }

  /**
   * Reactivates an account `deactivateIfNoMembership` deactivated, now that
   * a membership is active again: the same account, with its data. Any
   * other inactive account (a deleted one) stays as it is. Whether it was
   * reactivated now.
   */
  async reactivateDeprovisioned(tx: Transaction, userId: string) {
    const changed = await tx
      .update(users)
      .set({ active: true, deprovisionedAt: null })
      .where(and(eq(users.id, userId), isNotNull(users.deprovisionedAt)))
      .returning({ id: users.id });
    return changed.length > 0;
  }

  /** Whether the account is inactive because deprovisioning ended its last membership. */
  async isDeprovisioned(db: Db, userId: string) {
    const [row] = await db
      .select({ at: users.deprovisionedAt })
      .from(users)
      .where(eq(users.id, userId));
    return !!row?.at;
  }

  /**
   * Ends everything that acts in a tenant (the tenant deactivated): every
   * user's sessions in it and token families issued for it. Their other
   * tenants' go on: a new sign-in starts in one of those.
   */
  async endAllTenantSessions(tenantId: string, db: Db = this.db) {
    await db
      .delete(sessions)
      .where(sql`${sessions.metadata}->>'tenantId' = ${tenantId}`);
    await db
      .update(refreshTokens)
      .set({ revoked: true })
      .where(sql`${refreshTokens.claims}->>'tid' = ${tenantId}`);
  }

  async findView(id: string, db: Db = this.db) {
    const [row] = await db.select().from(users).where(eq(users.id, id));
    return row ? toView(row) : null;
  }

  /** An active account by its address, with what the sign-in flows need. */
  async findActiveByEmail(email: string) {
    const [row] = await this.db
      .select()
      .from(users)
      .where(eq(users.email, normalizeEmail(email)));
    return row?.active
      ? { user: toPrincipal(row), passwordHash: row.passwordHash }
      : null;
  }

  /**
   * A page of the members of `tenantId`, newest first: users are global,
   * so the tenant's members are reached through its memberships, never the
   * whole table. `active` is the membership's (in this tenant) and the
   * account's together.
   */
  async page(tenantId: string, query: PageQuery, where?: SQL) {
    // The list's filters read the membership too (`active`): the page and
    // its count both join it.
    const [rows, total] = await Promise.all([
      this.db
        .select({ user: users, membership: memberships.active })
        .from(users)
        .innerJoin(memberships, memberJoin(tenantId))
        .where(and(where, afterCursor(users.id, query)))
        .orderBy(...pageOrder(users.id, query))
        .limit(query.limit + 1)
        .offset(pageOffset(query)),
      countMatching(
        this.db,
        this.db
          .select({ one: sql`1` })
          .from(users)
          .innerJoin(memberships, memberJoin(tenantId))
          .where(where),
        query,
      ),
    ]);
    return toPage(
      rows.map((row) => toView(row.user, row.membership)),
      query,
      total,
    );
  }

  /** A member of `tenantId` by id, as the access API shows them; null for anyone else. */
  async findMember(tenantId: string, id: string, db: Db = this.db) {
    const [row] = await db
      .select({ user: users, membership: memberships.active })
      .from(users)
      .innerJoin(memberships, memberJoin(tenantId))
      .where(eq(users.id, id));
    return row ? toView(row.user, row.membership) : null;
  }

  async create(
    db: Db,
    input: {
      email: string;
      name: string;
      passwordHash: string | null;
      emailVerified?: boolean;
      locale?: string | null;
      timezone?: string | null;
    },
  ): Promise<UserView> {
    const [row] = await db
      .insert(users)
      .values({
        ...input,
        email: normalizeEmail(input.email),
      })
      .returning();
    return toView(row);
  }

  async update(
    db: Db,
    id: string,
    changes: Partial<
      Pick<
        Row,
        | 'name'
        | 'active'
        | 'passwordHash'
        | 'emailVerified'
        | 'locale'
        | 'timezone'
      >
    >,
  ): Promise<UserView | null> {
    const [row] = await db
      .update(users)
      .set(changes)
      .where(eq(users.id, id))
      .returning();
    return row ? toView(row) : null;
  }

  async updatePasswordHash(id: string, passwordHash: string, db: Db = this.db) {
    await db.update(users).set({ passwordHash }).where(eq(users.id, id));
  }

  /**
   * The account a verification link (still unspent, unexpired) is for, with
   * what verifying it requires: read without spending the link (the
   * package stores it by its SHA-256, base64url).
   */
  async pendingVerification(token: string) {
    const id = createHash('sha256').update(token).digest('base64url');
    const [row] = await this.db
      .select({
        userId: users.id,
        passwordHash: users.passwordHash,
        emailVerified: users.emailVerified,
      })
      .from(emailTokens)
      .innerJoin(users, eq(sql`${users.id}::text`, emailTokens.userId))
      .where(
        and(
          eq(emailTokens.id, id),
          eq(emailTokens.purpose, 'email-verification'),
          gt(emailTokens.expiresAt, new Date()),
        ),
      );
    return row;
  }

  /**
   * The account a password reset link is for, without spending it (the
   * new password's length is checked against its tenants first); undefined
   * for an unknown or expired link, which the reset then refuses.
   */
  async pendingReset(token: string) {
    const id = createHash('sha256').update(token).digest('base64url');
    const [row] = await this.db
      .select({ userId: emailTokens.userId })
      .from(emailTokens)
      .where(
        and(
          eq(emailTokens.id, id),
          eq(emailTokens.purpose, 'password-reset'),
          gt(emailTokens.expiresAt, new Date()),
        ),
      );
    return row?.userId;
  }

  /**
   * Whether the user was sent a verification link after `since` (a sign-up,
   * a resend): the public resend sends at most one per account in a while.
   */
  async verificationLinkSentSince(userId: string, since: Date) {
    const [row] = await this.db
      .select({ id: emailTokens.id })
      .from(emailTokens)
      .where(
        and(
          eq(emailTokens.userId, userId),
          eq(emailTokens.purpose, 'email-verification'),
          gt(emailTokens.createdAt, since),
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  /** Only while `email` is still the user's address: a link sent to an old one verifies nothing. */
  async markEmailVerified(
    id: string,
    email: string,
    db: Db = this.db,
  ): Promise<boolean> {
    const rows = await db
      .update(users)
      .set({ emailVerified: true })
      .where(and(eq(users.id, id), eq(users.email, normalizeEmail(email))))
      .returning({ id: users.id });
    return rows.length === 1;
  }
}

export const normalizeEmail = (email: string) =>
  email.trim().normalize('NFC').toLowerCase();

/** The name an anonymized account shows, in its audit entries too. */
export const DELETED_USER_NAME = 'Deleted user';

const toPrincipal = (row: Row): UserPrincipal => ({
  kind: 'user',
  id: row.id,
  email: row.email,
  name: row.name,
  emailVerified: row.emailVerified,
  locale: row.locale,
  timezone: row.timezone,
  tenantId: null,
});

/** Users who are members of `tenantId` (the `memberships` join's condition and the filter). */
const memberJoin = (tenantId: string) =>
  and(eq(memberships.userId, users.id), eq(memberships.tenantId, tenantId));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const toView = (row: Row, membershipActive = true): UserView => ({
  ...toPrincipal(row),
  active: row.active && membershipActive,
  hasPassword: row.passwordHash !== null,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});
