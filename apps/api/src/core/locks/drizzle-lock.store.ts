import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import {
  type LockAcquireResult,
  type LockStore,
  LocksStorage,
} from '@nestjs/locks';
import { and, eq, gt, sql } from 'drizzle-orm';
import { locks } from '../database/core.tables.js';
import type { Database } from '../database/drizzle.js';

/** `ttl` from now, on the database's clock. */
const expiresIn = (ttl: number) =>
  sql`clock_timestamp() + ${ttl} * interval '1 millisecond'`;

/** The lock on `key`, if `owner` still holds it: the compare-and-set of renew() and release(). */
const heldBy = (key: string, owner: string) =>
  and(
    eq(locks.key, key),
    eq(locks.owner, owner),
    gt(locks.expiresAt, sql`clock_timestamp()`),
  );

/**
 * @nestjs/locks on PostgreSQL (the `locks` table), as the locks chapter of
 * the NestJS docs writes it: every instance shares the locks, each decision is
 * one conditional statement, and expiry is on the database's clock.
 */
@Injectable()
export class DrizzleLockStore implements LockStore {
  constructor(
    @InjectDrizzle() private readonly db: Database,
    storage: LocksStorage,
  ) {
    storage.registerSource(this);
  }

  async acquire(
    key: string,
    owner: string,
    ttl: number,
  ): Promise<LockAcquireResult> {
    // One statement: insert the lock, or take over a released or expired one.
    const [row] = await this.db
      .insert(locks)
      .values({
        key,
        owner,
        fencingToken: sql`nextval('locks_fencing_token_seq')`,
        expiresAt: expiresIn(ttl),
      })
      .onConflictDoUpdate({
        target: locks.key,
        // nextval() runs after the row is locked: a later holder always gets a greater
        // token. The row's own token is the floor, should the sequence ever go back.
        set: {
          owner,
          fencingToken: sql`greatest(nextval('locks_fencing_token_seq'), ${locks.fencingToken} + 1)`,
          expiresAt: expiresIn(ttl),
        },
        setWhere: sql`${locks.owner} is null or ${locks.expiresAt} <= clock_timestamp()`,
      })
      .returning({ fencingToken: locks.fencingToken });
    return row
      ? { acquired: true, fencingToken: row.fencingToken }
      : { acquired: false };
  }

  async renew(key: string, owner: string, ttl: number): Promise<boolean> {
    const rows = await this.db
      .update(locks)
      .set({ expiresAt: expiresIn(ttl) })
      .where(heldBy(key, owner))
      .returning({ key: locks.key });
    return rows.length === 1;
  }

  async release(key: string, owner: string): Promise<boolean> {
    // Keep the row, so the next acquire() takes the update path, whose token is drawn after the row lock.
    const rows = await this.db
      .update(locks)
      .set({ owner: null })
      .where(heldBy(key, owner))
      .returning({ key: locks.key });
    return rows.length === 1;
  }
}
