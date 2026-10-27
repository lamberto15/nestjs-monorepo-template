/**
 * The stores this app implements on PostgreSQL, against the contract suites
 * their packages ship, on a database of their own (a copy of the migrated template).
 */
import { TenantQuotas } from '../src/core/tenancy/tenant-quotas.js';
import { UsersRepository } from '../src/iam/auth/users.repository.js';
import { testDatabase } from './support.js';
import { AuthenticationStorage } from '@nestjs/authentication';
import { authenticationStoreContract } from '@nestjs/authentication/testing';
import { LocksStorage } from '@nestjs/locks';
import { lockStoreContract } from '@nestjs/locks/testing';
import type { TransactionHost } from '@nestjs-cls/transactional';
import type { Database } from '../src/core/database/drizzle.js';
import type { DrizzleTransactions } from '../src/core/database/transactions.js';
import { DrizzleLockStore } from '../src/core/locks/drizzle-lock.store.js';
import { DrizzleAuthenticationStore } from '../src/iam/auth/drizzle-authentication.store.js';
import { SessionLifecycleRegistry } from '../src/iam/auth/session-lifecycle.registry.js';
import { randomUUID } from 'node:crypto';

describe('DrizzleLockStore and DrizzleAuthenticationStore, their contracts (PostgreSQL)', () => {
  let database: Awaited<ReturnType<typeof testDatabase>>;
  let db: Database;
  beforeAll(async () => {
    database = await testDatabase();
    db = database.db;
  });
  afterAll(() => database.close());

  // The expiry cases wait on PostgreSQL's clock: about 25 seconds in all.
  for (const contractCase of lockStoreContract(
    () => new DrizzleLockStore(db, new LocksStorage()),
    { concurrent: true },
  )) {
    it(contractCase.name, () => contractCase.run(), 30_000);
  }

  for (const contractCase of authenticationStoreContract(
    () => {
      // No request, no transaction: a host whose current "transaction" is the database.
      const store = new DrizzleAuthenticationStore(
        { tx: db } as unknown as TransactionHost<DrizzleTransactions>,
        new UsersRepository(
          {
            tx: db,
          } as unknown as TransactionHost<DrizzleTransactions>,
          // Reads only: no seat is taken.
          { count: () => undefined } as unknown as TenantQuotas,
        ),
        new AuthenticationStorage(),
      );
      return {
        sessions: store,
        refreshTokens: store,
        mfa: store,
        magicLinks: store,
        oidcStates: store,
        emailTokens: store,
      };
    },
    { concurrent: true },
  )) {
    it(contractCase.name, () => contractCase.run());
  }

  it("names a revoked family's sid to the listeners, once, and knows it revoked", async () => {
    const host = { tx: db } as unknown as TransactionHost<DrizzleTransactions>;
    const lifecycle = new SessionLifecycleRegistry();
    const ended: string[] = [];
    lifecycle.register({
      name: 'test',
      afterRevocation: () => undefined,
      afterTokenRevocation: (sid) => {
        ended.push(sid);
      },
    });
    const store = new DrizzleAuthenticationStore(
      host,
      new UsersRepository(host, {
        count: () => undefined,
      } as unknown as TenantQuotas),
      new AuthenticationStorage(),
      lifecycle,
    );
    const userId = randomUUID();
    const now = Date.now();
    const token = (familyId: string, claims?: Record<string, unknown>) =>
      store.saveRefreshToken({
        id: randomUUID(),
        familyId,
        userId,
        createdAt: new Date(now),
        expiresAt: new Date(now + 60_000),
        familyExpiresAt: new Date(now + 60_000),
        ...(claims && { claims }),
      });
    // Family A rotated once (two tokens, one sid), B, and one from before `sid`.
    await token('family-a', { sid: 'sid-a' });
    await token('family-a', { sid: 'sid-a' });
    await token('family-b', { sid: 'sid-b' });
    await token('family-old');

    await store.revokeRefreshTokenFamily('family-a');
    expect(ended).toEqual(['sid-a']);
    expect(await store.isTokenSessionRevoked(userId, 'sid-a')).toBe(true);
    expect(await store.isTokenSessionRevoked(userId, 'sid-b')).toBe(false);
    // Another user's sid is never theirs.
    expect(await store.isTokenSessionRevoked(randomUUID(), 'sid-a')).toBe(
      false,
    );

    // Everywhere: the families still live, A not again.
    await store.revokeUserRefreshTokens(userId);
    expect(ended).toEqual(['sid-a', 'sid-b']);
    expect(await store.isTokenSessionRevoked(userId, 'sid-b')).toBe(true);
  });
});
