import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import {
  database,
  type DrizzleTransactions,
} from '../../core/database/transactions.js';
import { and, eq, type SQL } from 'drizzle-orm';
import {
  afterCursor,
  countPage,
  pageOffset,
  pageOrder,
  type PageQuery,
  toPage,
} from '../../core/http/pagination.js';
import type { Database, Transaction } from '../../core/database/drizzle.js';
import {
  auditLog,
  mfaAuthenticators,
  mfaFailures,
  mfaRecoveryCodes,
  passkeys,
  refreshTokens,
  sessions,
  userIdentities,
  userOrgUnits,
  userRoles,
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

  /** The signed-in principal, or `null` when the account is gone or deactivated. */
  async findActive(id: string): Promise<UserPrincipal | null> {
    const [row] = await this.db.select().from(users).where(eq(users.id, id));
    return row?.active ? toPrincipal(row) : null;
  }

  /**
   * Removes the person from an account (their deletion, platform/account):
   * a placeholder address and name, no password, no sign-in methods
   * (providers, passkeys), sessions, tokens, roles or units; deactivated. Their audit entries keep
   * the actor key (`user:<id>`), labelled "Deleted user" instead of the
   * address. The row stays: what references it (records they created)
   * keeps pointing at an account that is nobody's.
   */
  async anonymize(tx: Transaction, id: string) {
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
      })
      .where(eq(users.id, id));
    await tx.delete(userIdentities).where(eq(userIdentities.userId, id));
    await tx.delete(passkeys).where(eq(passkeys.userId, id));
    await tx.delete(userRoles).where(eq(userRoles.userId, id));
    await tx.delete(userOrgUnits).where(eq(userOrgUnits.userId, id));
    await tx.delete(mfaAuthenticators).where(eq(mfaAuthenticators.userId, id));
    await tx.delete(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, id));
    await tx.delete(mfaFailures).where(eq(mfaFailures.userId, id));
    await tx.delete(sessions).where(eq(sessions.userId, id));
    await tx
      .update(refreshTokens)
      .set({ revoked: true })
      .where(eq(refreshTokens.userId, id));
    await tx
      .update(auditLog)
      .set({ actorLabel: DELETED_USER_NAME })
      .where(eq(auditLog.actor, `user:${id}`));
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

  /** A page of the users, newest first. */
  async page(query: PageQuery, where?: SQL) {
    const [rows, total] = await Promise.all([
      this.db
        .select()
        .from(users)
        .where(and(where, afterCursor(users.id, query)))
        .orderBy(...pageOrder(users.id, query))
        .limit(query.limit + 1)
        .offset(pageOffset(query)),
      countPage(this.db, users, where, query),
    ]);
    return toPage(rows.map(toView), query, total);
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
      Pick<Row, 'name' | 'active' | 'passwordHash' | 'locale' | 'timezone'>
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

  /** Only while `email` is still the user's address: a link sent to an old one verifies nothing. */
  async markEmailVerified(id: string, email: string): Promise<boolean> {
    const rows = await this.db
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
});

const toView = (row: Row): UserView => ({
  ...toPrincipal(row),
  active: row.active,
  hasPassword: row.passwordHash !== null,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});
