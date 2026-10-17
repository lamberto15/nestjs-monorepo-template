import { getDrizzleToken } from '@nestjs/drizzle';
import { count, eq, like, sql } from 'drizzle-orm';
import { Client } from 'pg';
import { inject } from 'vitest';
import type { Database } from '../src/core/database/drizzle.js';
import { DEMO_USERS } from '../src/demo/demo-data.js';
import { DemoSeedRefused } from '../src/demo/demo-guard.js';
import { DemoSeedModule } from '../src/demo/demo-seed.module.js';
import { type DemoCredentials, DemoSeeder } from '../src/demo/demo-seeder.js';
import { tenants } from '../src/core/tenancy/tenancy.tables.js';
import { users } from '../src/iam/iam.tables.js';
import { bootApp, type TestApp } from './support.js';

/**
 * The demo seed (pnpm db:seed:demo, src/demo): on a development database
 * only, through the services, as `system:demo-seed`, once.
 */
describe('demo seed (e2e)', () => {
  let node: TestApp;
  let db: Database;
  let seeder: DemoSeeder;

  beforeEach(async () => {
    node = await bootApp(undefined, undefined, { module: DemoSeedModule });
    db = node.app.get<Database>(getDrizzleToken());
    seeder = node.app.get(DemoSeeder);
  });
  afterEach(async () => {
    await node.close();
  });

  /**
   * Marks the test's database as the development services mark theirs
   * (dev/postgres/10-dev-database.sql): as the server's superuser, the only
   * kind of role that may.
   */
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

  /**
   * What the seed writes outside its tenant: the demo tenant and the demo
   * accounts (global tables). Without the tenant, nothing of it exists in
   * a tenant table either: they all carry the tenant's id.
   */
  async function written() {
    const [{ demoTenants }] = await db
      .select({ demoTenants: count() })
      .from(tenants)
      .where(eq(tenants.slug, 'demo'));
    const [{ demoUsers }] = await db
      .select({ demoUsers: count() })
      .from(users)
      .where(like(users.email, '%@demo.example.com'));
    return { demoTenants, demoUsers };
  }
  const nothing = { demoTenants: 0, demoUsers: 0 };

  /** Runs `work` with NODE_ENV set to `value` (unset for undefined), then puts it back. */
  async function withNodeEnv<T>(
    value: string | undefined,
    work: () => Promise<T>,
  ) {
    const before = process.env.NODE_ENV;
    if (value === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = value;
    }
    try {
      return await work();
    } finally {
      process.env.NODE_ENV = before;
    }
  }

  it('refuses a database not marked as a development one, whatever NODE_ENV says, and writes nothing', async () => {
    for (const nodeEnv of ['development', 'test']) {
      const refused = await withNodeEnv(nodeEnv, () => seeder.seed()).catch(
        (error: unknown) => error,
      );
      expect(refused).toBeInstanceOf(DemoSeedRefused);
      expect((refused as Error).message).toMatch(
        /isn't marked as a development database/,
      );
    }
    expect(await written()).toEqual(nothing);
  });

  it('refuses a NODE_ENV other than development or test, on a marked database too, and writes nothing', async () => {
    await markAsDevelopment();
    for (const nodeEnv of ['production', 'staging', undefined]) {
      const refused = await withNodeEnv(nodeEnv, () => seeder.seed()).catch(
        (error: unknown) => error,
      );
      expect(refused).toBeInstanceOf(DemoSeedRefused);
      expect((refused as Error).message).toMatch(/NODE_ENV=development/);
    }
    expect(await written()).toEqual(nothing);
  });

  it('seeds a marked database through the services, as system:demo-seed, once', async () => {
    await markAsDevelopment();
    const result = await seeder.seed();
    if (!result.seeded) {
      throw new Error('expected the seed to run');
    }
    expect(result.users).toHaveLength(DEMO_USERS.length);
    // What the features' demos made, by name: whichever features there are.
    expect(result.data).toEqual(expect.any(Object));
    // Generated passwords, each its own.
    expect(new Set(result.users.map((user) => user.password)).size).toBe(
      DEMO_USERS.length,
    );

    const credentials = (name: string) =>
      result.users.find((user) => user.name === name) as DemoCredentials;
    const signIn = (name: string) =>
      node.signIn(credentials(name).email, credentials(name).password);

    // A viewer, by their role.
    expect(credentials('Elena Novak').roles).toEqual(['Viewer']);

    // Everyone lands in the demo tenant, its only one. Its administrator
    // administers that tenant alone: no operator.
    expect(result.tenant).toBe('Demo Company');
    expect(result.operators).toBe(false);
    expect(credentials('Noah Fischer').roles).toEqual(['Administrator']);
    const admin = await signIn('Noah Fischer');
    const me = (await admin.get('/v1/auth/me').expect(200)).body as {
      tenant: { slug: string } | null;
    };
    expect(me.tenant?.slug).toBe('demo');
    for (const name of ['Noah Fischer', 'Jonas Berg']) {
      const { items } = (
        await (await signIn(name)).get('/v1/auth/tenants').expect(200)
      ).body as { items: { slug: string }[] };
      expect(items.map((tenant) => tenant.slug)).toEqual(['demo']);
    }
    await admin
      .get('/v1/tenants')
      .expect(403)
      .expect((res) => expect(res.body.code).toBe('operator_required'));
    // Every write is audited with the seed as its actor, each feature's demo data included.
    const audited = (
      await admin
        .get('/v1/access/audit?actor=system:demo-seed&limit=100')
        .expect(200)
    ).body.items as { action: string; actorLabel: string }[];
    const actions = new Set(audited.map((entry) => entry.action));
    for (const action of ['team.created', 'user.seeded', 'demo.seeded']) {
      expect(actions).toContain(action);
    }
    expect(new Set(audited.map((entry) => entry.actorLabel))).toEqual(
      new Set(['System: Demo seed']),
    );

    // Once: a second run finds the demo users and changes nothing.
    const before = await written();
    const again = await seeder.seed();
    expect(again).toEqual({ seeded: false, since: expect.any(Date) });
    expect(await written()).toEqual(before);
  });
});
