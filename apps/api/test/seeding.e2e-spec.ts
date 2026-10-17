import { getDrizzleToken } from '@nestjs/drizzle';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  ManualWorkflowClock,
  WORKFLOWS_MODULE_OPTIONS,
} from '@nestjs/workflows';
import { count, eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import { AppModule } from '../src/app.module.js';
import { PASSWORD_HASHER_PARAMS } from '../src/iam/account/password-hashing.js';
import { createDatabase, type Database } from '../src/core/database/drizzle.js';
import { auditLog, roles, users } from '../src/iam/iam.tables.js';
import { tenants } from '../src/core/tenancy/tenancy.tables.js';
import { bypassingTenants, testDatabase } from './support.js';

/**
 * The first start of a deployment: every process (api replicas, the worker)
 * seeds at once on an empty database. One of them must seed, the others
 * must start and find it done.
 */
describe('first start (seeding)', () => {
  /** The apps' pools: not the app's to close (the provider is overridden), so the test does. */
  const pools: Pool[] = [];

  /** An app on its own pool over `url`, as a separate process would be. */
  async function app(url: string) {
    const db = await createDatabase({
      url,
      migrate: false,
      pool: {
        max: 5,
        timeoutMs: 30_000,
        statementTimeoutMs: 30_000,
        idleTxTimeoutMs: 60_000,
        applicationName: 'tests',
      },
    });
    const pool = (db as unknown as { $client: Pool }).$client;
    // As testDatabase() does: pool.end() resolves once Terminate is sent to
    // its idle clients, and the database is dropped with (force) right after,
    // which can reach a socket still open; without a listener that is an
    // unhandled 'error' event (57P01) that fails the run on CI.
    pool.on('error', (error) =>
      console.warn(`Seeding test pool: ${error.message}`),
    );
    pools.push(pool);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(getDrizzleToken())
      .useValue(db)
      .overrideProvider(WORKFLOWS_MODULE_OPTIONS)
      .useValue({
        clock: new ManualWorkflowClock(),
        worker: { enabled: false, shutdownTimeout: 50 },
      })
      .overrideProvider(PASSWORD_HASHER_PARAMS)
      .useValue({ logN: 10 })
      .compile();
    return moduleRef.createNestApplication({ logger: false });
  }

  it('seeds once when several processes start together', async () => {
    const database = await testDatabase();
    const apps: INestApplication[] = [];
    try {
      apps.push(
        await app(database.url),
        await app(database.url),
        await app(database.url),
      );
      // onModuleInit (the seeder) runs in init(): all three at once.
      const started = await Promise.allSettled(apps.map((each) => each.init()));
      expect(started.map((result) => result.status)).toEqual([
        'fulfilled',
        'fulfilled',
        'fulfilled',
      ]);

      const db: Database = database.db;
      // Every tenant's rows (the roles are a tenant table).
      const [{ tenantsMade }] = await bypassingTenants(() =>
        db.select({ tenantsMade: count() }).from(tenants),
      );
      expect(tenantsMade).toBe(1);
      const [{ administrators }] = await db
        .select({ administrators: count() })
        .from(users);
      expect(administrators).toBe(1);
      const [{ seededRoles }] = await bypassingTenants(() =>
        db
          .select({ seededRoles: count() })
          .from(roles)
          .where(eq(roles.key, 'administrator')),
      );
      expect(seededRoles).toBe(1);
      const [{ entries }] = await bypassingTenants(() =>
        db
          .select({ entries: count() })
          .from(auditLog)
          .where(eq(auditLog.action, 'user.seeded')),
      );
      expect(entries).toBe(1);
    } finally {
      await Promise.all(apps.map((each) => each.close()));
      await Promise.all(pools.splice(0).map((pool) => pool.end()));
      await database.close();
    }
  });
});
