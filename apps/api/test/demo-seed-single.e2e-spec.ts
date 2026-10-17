import { getDrizzleToken } from '@nestjs/drizzle';
import { sql } from 'drizzle-orm';
import { Client } from 'pg';
import { inject } from 'vitest';
import type { Database } from '../src/core/database/drizzle.js';
import { DEMO_USERS } from '../src/demo/demo-data.js';
import { DemoSeedModule } from '../src/demo/demo-seed.module.js';
import { type DemoCredentials, DemoSeeder } from '../src/demo/demo-seeder.js';
import { bootApp, type TestApp } from './support.js';

// Read when AppModule loads: a single-tenant deployment.
vi.hoisted(() => {
  process.env.TENANCY = 'single';
});

/**
 * The demo seed with TENANCY=single (docs/tenancy.md, "Single-tenant
 * deployments"): no tenant of its own, which the deployment refuses, but
 * the one there is, once.
 */
describe('demo seed, single tenant (e2e)', () => {
  let node: TestApp;
  let db: Database;

  beforeEach(async () => {
    node = await bootApp(undefined, undefined, { module: DemoSeedModule });
    db = node.app.get<Database>(getDrizzleToken());
  });
  afterEach(() => node.close());

  /** As demo-seed.e2e-spec.ts: the development services' marker, set as the superuser. */
  async function markAsDevelopment() {
    const { rows } = (await db.execute(
      sql`select current_database() as name`,
    )) as unknown as { rows: { name: string }[] };
    const admin = new Client({ connectionString: inject('postgresUrl') });
    await admin.connect();
    try {
      await admin.query(
        `alter database "${rows[0]!.name}" set app.dev_database = 'on'`,
      );
    } finally {
      await admin.end();
    }
  }

  it('fills the one tenant, once', async () => {
    await markAsDevelopment();
    const seeder = node.app.get(DemoSeeder);
    const result = await seeder.seed();
    if (!result.seeded) {
      throw new Error('expected the seed to run');
    }
    expect(result.tenant).toBe(process.env.ADMIN_TENANT_NAME ?? 'Default');
    expect(result.operators).toBe(true);
    expect(result.users).toHaveLength(DEMO_USERS.length);
    expect(result.data).toEqual(expect.any(Object));

    // Still one tenant, and the demo users act in it.
    const tenants = (await node.admin().get('/v1/tenants').expect(200)).body
      .items as { id: string }[];
    expect(tenants.map((tenant) => tenant.id)).toEqual([node.tenantId]);
    const elena = result.users.find(
      (user) => user.name === 'Elena Novak',
    ) as DemoCredentials;
    const viewer = await node.signIn(elena.email, elena.password);
    const me = await viewer.get('/v1/auth/me').expect(200);
    expect(me.body.user.tenantId).toBe(node.tenantId);

    // A second run finds the demo users: nothing written.
    const again = await seeder.seed();
    expect(again.seeded).toBe(false);
  });
});
