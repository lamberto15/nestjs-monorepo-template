import { sql } from 'drizzle-orm';
import type { Pool } from 'pg';
import { createDatabase, type Database } from '../src/core/database/drizzle.js';
import { inTenantOf } from '../src/core/tenancy/tenant-job.js';
import { TenantScopeMissingError } from '../src/core/tenancy/tenant-scope.js';
import { tenants } from '../src/core/tenancy/tenancy.tables.js';
import { testItems } from './fixtures/test-items/test-items.tables.js';
import { bypassingTenants, testDatabase } from './support.js';

/**
 * The pool's life cycle (core/tenancy/tenant-pool.ts) on a real
 * PostgreSQL, one connection only, so every statement reuses the client
 * the one before it left: the settings ride with `begin` and end with the
 * transaction, global tables pass straight, and a statement without a
 * tenant is refused before any client is checked out.
 */
describe('TenantPool', () => {
  let database: Awaited<ReturnType<typeof testDatabase>>;
  let db: Database;
  let pool: Pool;
  let tenantId: string;

  beforeAll(async () => {
    database = await testDatabase();
    db = await createDatabase({
      url: database.url,
      maintenanceUrl: database.maintenanceUrl,
      migrate: false,
      pool: {
        max: 1,
        timeoutMs: 10_000,
        statementTimeoutMs: 10_000,
        idleTxTimeoutMs: 10_000,
        applicationName: 'tests',
      },
    });
    pool = (db as unknown as { $client: Pool }).$client;
    const [tenant] = await db
      .insert(tenants)
      .values({ slug: 'pool', name: 'Pool' })
      .returning({ id: tenants.id });
    tenantId = tenant!.id;
    await inTenantOf({ tenantId }, () =>
      db.insert(testItems).values({
        ownerId: 'client:x',
        title: 'A',
        body: '',
      }),
    );
  });
  afterAll(async () => {
    await pool.end();
    await database.close();
  });

  const inTenant = <T>(work: () => Promise<T>) =>
    inTenantOf({ tenantId }, work);

  const rowsOf = <T>(result: unknown) => (result as { rows: T[] }).rows;

  /** The tenant setting a statement saw, in the order it ran. */
  const settingIn = (from: 'testItems' | 'tenants') =>
    db.execute<{ t: string | null }>(
      sql`select current_setting('app.tenant_id', true) as t from ${from === 'testItems' ? testItems : tenants} limit 1`,
    );

  it('wraps a statement on a tenant table in a transaction with the settings, and passes global ones straight', async () => {
    const onItems = await inTenant(() => settingIn('testItems'));
    expect(rowsOf(onItems)).toEqual([{ t: tenantId }]);
    // A global table, in the same scope: no transaction, no settings (the
    // connection's own value: empty after the last transaction's end).
    const onTenants = await inTenant(() => settingIn('tenants'));
    expect(rowsOf<{ t: string | null }>(onTenants)[0]?.t ?? '').toBe('');
  });

  it('refuses a tenant table without a tenant, before checking out a client', async () => {
    await pool.end().catch(() => undefined);
    const fresh = await createDatabase({
      url: database.url,
      migrate: false,
      pool: {
        max: 1,
        timeoutMs: 10_000,
        statementTimeoutMs: 10_000,
        idleTxTimeoutMs: 10_000,
        applicationName: 'tests',
      },
    });
    const freshPool = (fresh as unknown as { $client: Pool }).$client;
    try {
      const refused = await fresh
        .select()
        .from(testItems)
        .catch((error: { cause?: unknown }) => error.cause);
      expect(refused).toBeInstanceOf(TenantScopeMissingError);
      expect(freshPool.totalCount).toBe(0);
    } finally {
      await freshPool.end();
    }
    // The suite's own pool, again.
    db = await createDatabase({
      url: database.url,
      maintenanceUrl: database.maintenanceUrl,
      migrate: false,
      pool: {
        max: 1,
        timeoutMs: 10_000,
        statementTimeoutMs: 10_000,
        idleTxTimeoutMs: 10_000,
        applicationName: 'tests',
      },
    });
    pool = (db as unknown as { $client: Pool }).$client;
  });

  it('forgets a transaction’s tenant at its commit and at its rollback', async () => {
    await inTenant(() =>
      db.transaction(async (tx) => {
        expect(
          await tx.select({ id: testItems.id }).from(testItems),
        ).toHaveLength(1);
      }),
    );
    // The same (only) connection, no tenant: refused, not run in the last one.
    const afterCommit = await db
      .transaction((tx) => tx.select().from(testItems))
      .catch((error: { cause?: unknown }) => error.cause ?? error);
    expect(afterCommit).toBeInstanceOf(TenantScopeMissingError);

    await inTenant(() =>
      db
        .transaction(async (tx) => {
          await tx.select().from(testItems);
          throw new Error('rolled back');
        })
        .catch(() => undefined),
    );
    const afterRollback = await db
      .transaction((tx) => tx.select().from(testItems))
      .catch((error: { cause?: unknown }) => error.cause ?? error);
    expect(afterRollback).toBeInstanceOf(TenantScopeMissingError);
    // And the connection is healthy: a tenant's transaction reads again.
    expect(
      await inTenant(() => db.select({ id: testItems.id }).from(testItems)),
    ).toHaveLength(1);
  });

  it('runs the bypass as the maintenance role, past every tenant, never as the app role', async () => {
    const seen = await bypassingTenants(() =>
      db.execute<{ role: string; items: number }>(
        sql`select current_user as role, (select count(*) from ${testItems})::int as items`,
      ),
    );
    expect(rowsOf(seen)[0]).toMatchObject({
      role: expect.stringMatching(/^maint_/),
      items: 1,
    });
    const app = await inTenant(() =>
      db.execute<{ role: string }>(
        sql`select current_user as role from ${testItems} limit 1`,
      ),
    );
    expect(rowsOf<{ role: string }>(app)[0]?.role).toMatch(/^app_/);
  });
});
