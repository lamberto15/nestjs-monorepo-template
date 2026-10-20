import { randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { Client } from 'pg';
import { inject } from 'vitest';
import { ensureReportingRole } from '../src/core/database/roles.js';
import { users } from '../src/iam/iam.tables.js';
import { PlatformAnalyticsJob } from '../src/platform/analytics/platform-analytics.job.js';
import { databaseUrl } from './global-setup.js';
import { bootApp, type TestApp } from './support.js';

// Read when AppModule loads. Small, so a test's handful of users makes
// figures both kept and withheld.
const MIN_GROUP = 3;
vi.hoisted(() => {
  process.env.ANALYTICS_MIN_GROUP_SIZE = '3';
});

/**
 * Platform analytics (docs/tenancy.md, "Platform analytics"; roadmap 1b):
 * the worker counts across tenants under the bypass and stores only
 * anonymized, suppressed aggregates; the reporting role reads those and
 * nothing else.
 */
describe('platform analytics (e2e)', () => {
  let node: TestApp;
  beforeAll(async () => {
    node = await bootApp();
  });
  afterAll(async () => {
    await node.close();
  });

  type Row = { metric: string; dimension: string; value: string | null };
  const asOwner = async <T>(work: (client: Client) => Promise<T>) => {
    const client = new Client({ connectionString: node.database.ownerUrl });
    await client.connect();
    try {
      return await work(client);
    } finally {
      await client.end();
    }
  };

  it('stores counts across tenants, withholding small groups and what would give them away', async () => {
    await node.user(['editor']);
    await node.user(['viewer']);
    const { id: german } = await node.user(['viewer']);
    // One user with a locale of their own: a group of one.
    await node.db
      .update(users)
      .set({ locale: 'de' })
      .where(eq(users.id, german));
    await node.client();

    const job = node.app.get(PlatformAnalyticsJob);
    const now = new Date();
    const stored = await job.run(now);
    expect(stored.length).toBeGreaterThan(0);

    const day = now.toISOString().slice(0, 10);
    const rows = await asOwner(
      async (client) =>
        (
          await client.query<Row>(
            `select metric, dimension, value from analytics.platform_metrics
             where day = $1 order by metric, dimension`,
            [day],
          )
        ).rows,
    );
    const figure = (metric: string, dimension = '') =>
      rows.find((row) => row.metric === metric && row.dimension === dimension);
    const truth = await asOwner(
      async (client) =>
        (
          await client.query<{ n: string }>(
            `select count(*) as n from users where active`,
          )
        ).rows[0]!.n,
    );
    expect(Number(truth)).toBeGreaterThanOrEqual(MIN_GROUP);
    expect(figure('users.active')).toMatchObject({ value: truth });
    // `de` is one user: withheld; the only other locale would give it away
    // (users.active minus it), so it is withheld too.
    expect(figure('users.by_locale', 'de')).toMatchObject({ value: null });
    expect(figure('users.by_locale', 'unset')).toMatchObject({ value: null });
    // One API client: withheld.
    expect(figure('api_clients.active')).toMatchObject({ value: null });
    // No stored figure counts fewer than the minimum group, zero aside.
    for (const row of rows) {
      if (row.value !== null) {
        const value = Number(row.value);
        expect([row, value === 0 || value >= MIN_GROUP]).toEqual([row, true]);
      }
    }
    // Nothing names a tenant, a user or a client: the dimensions are buckets and locales.
    const ids = await asOwner(async (client) =>
      (
        await client.query<{ id: string }>(
          `select id::text from tenants union all select id::text from users
             union all select id::text from api_clients`,
        )
      ).rows.map((row) => row.id),
    );
    for (const row of rows) {
      expect(ids).not.toContain(row.dimension);
    }

    // Again the same day: the figures are replaced, not added.
    await job.run(now);
    const again = await asOwner(
      async (client) =>
        (
          await client.query<{ n: string }>(
            `select count(*) as n from analytics.platform_metrics where day = $1`,
            [day],
          )
        ).rows[0]!.n,
    );
    expect(Number(again)).toBe(rows.length);
  });

  it('lets the reporting role read the aggregates and no tenant row', async () => {
    const role = `reporting_${randomUUID().slice(0, 8)}`;
    const password = randomBytes(12).toString('hex');
    await ensureReportingRole(
      { ownerUrl: node.database.ownerUrl, appUrl: node.database.url },
      { role, password },
    );
    const url = new URL(node.database.ownerUrl);
    url.username = role;
    url.password = password;
    const client = new Client({ connectionString: url.toString() });
    await client.connect();
    try {
      const { rows } = await client.query(
        `select count(*)::int as n from analytics.platform_metrics`,
      );
      expect(rows[0].n).toBeGreaterThan(0);
      for (const table of ['users', 'api_clients', 'memberships', 'tenants']) {
        await expect(client.query(`select 1 from ${table}`)).rejects.toThrow(
          /permission denied/,
        );
      }
    } finally {
      await client.end();
      const admin = new Client({
        connectionString: databaseUrl(
          inject('postgresUrl'),
          new URL(node.database.url).pathname.slice(1),
        ),
      });
      await admin.connect();
      try {
        await admin.query(
          `drop owned by "${role}"; drop role if exists "${role}"`,
        );
      } finally {
        await admin.end();
      }
    }
  });
});
