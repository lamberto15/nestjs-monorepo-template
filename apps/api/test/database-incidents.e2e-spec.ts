import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { Client, type Pool } from 'pg';
import { inject } from 'vitest';
import { createDatabase } from '../src/core/database/drizzle.js';
import { databaseIncident } from '../src/core/database/database-observer.js';
import { ensureMonitorRole } from '../src/core/database/roles.js';
import type { TenantPool } from '../src/core/tenancy/tenant-pool.js';
import { testDatabase } from './support.js';

describe('automatic database incidents on PostgreSQL', () => {
  let database: Awaited<ReturnType<typeof testDatabase>>;
  let monitorUrl: string;
  const role = `diagnostics_${randomUUID().slice(0, 8)}`;
  const password = randomBytes(16).toString('hex');
  let warning: ReturnType<typeof vi.spyOn>;
  const pools: (Pool & Pick<TenantPool, 'observer'>)[] = [];
  beforeAll(async () => {
    database = await testDatabase();
    await ensureMonitorRole(
      { ownerUrl: database.ownerUrl, appUrl: database.url },
      { role, password },
    );
    const url = new URL(database.url);
    url.username = role;
    url.password = password;
    monitorUrl = url.toString();
  });
  beforeEach(() => {
    warning = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
  });
  afterEach(async () => {
    await Promise.all(pools.splice(0).map((pool) => pool.end()));
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await database.close();
    const admin = new Client({ connectionString: inject('postgresUrl') });
    await admin.connect();
    try {
      await admin.query(`drop role "${role}"`);
    } finally {
      await admin.end();
    }
  });
  const events = () =>
    warning.mock.calls.map((call: unknown[]) => call[1]) as Record<
      string,
      unknown
    >[];
  const poolOf = async (statementTimeoutMs = 3000, monitor = monitorUrl) => {
    const db = await createDatabase({
      url: database.url,
      monitorUrl: monitor,
      migrate: false,
      pool: {
        max: 1,
        timeoutMs: 100,
        statementTimeoutMs,
        idleTxTimeoutMs: 5000,
        applicationName: 'incident-tests',
      },
    });
    const pool = (
      db as unknown as { $client: Pool & Pick<TenantPool, 'observer'> }
    ).$client;
    pools.push(pool);
    return pool;
  };

  it('captures independently while the application pool is exhausted', async () => {
    const pool = await poolOf();
    const held = await pool.connect();
    try {
      const running = held.query('select pg_sleep(0.3)');
      await expect(pool.query('select 1')).rejects.toThrow(
        'timeout exceeded when trying to connect',
      );
      await vi.waitFor(() =>
        expect(events()).toContainEqual(
          expect.objectContaining({
            event: 'database_snapshot',
            captureStatus: 'captured',
          }),
        ),
        { timeout: 3000 },
      );
      expect(events()).toContainEqual(
        expect.objectContaining({
          trigger: 'database_busy',
          pool: expect.objectContaining({ max: 1, inUse: 1 }),
        }),
      );
      await running;
    } finally {
      held.release();
    }
    expect((await pool.query('select 1 as n')).rows).toEqual([{ n: 1 }]);
  });

  it('preserves statement timeout and identifies its cancellation reason without SQL or values', async () => {
    const pool = await poolOf(100);
    const error = await pool
      .query('select pg_sleep($1), $2::text', [1, 'private-note'])
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: '57014' });
    expect(databaseIncident(error)).toMatchObject({
      trigger: 'database_timeout',
      reason: 'statement_timeout',
    });
    await vi.waitFor(() =>
      expect(events()).toContainEqual(
        expect.objectContaining({
          event: 'database_snapshot',
          captureStatus: 'captured',
        }),
      ),
      { timeout: 3000 },
    );
    expect(JSON.stringify(events())).not.toContain('private-note');
    expect(JSON.stringify(events())).not.toContain('pg_sleep');
  });

  it('captures a real blocker while the slow statement is still waiting', async () => {
    const pool = await poolOf(5000);
    const blocker = new Client({ connectionString: database.ownerUrl });
    await blocker.connect();
    const key = randomInt(1_000_000_000);
    let running: Promise<unknown> | undefined;
    try {
      await blocker.query('begin');
      await blocker.query('select pg_advisory_xact_lock($1)', [key]);
      running = pool
        .query('select pg_advisory_xact_lock($1)', [key])
        .catch((e: unknown) => e);
      await vi.waitFor(
        () => {
          const snapshot = events().find((e) => e.captureStatus === 'captured');
          expect(snapshot).toBeDefined();
          expect(snapshot?.sessions).toContainEqual(
            expect.objectContaining({
              waitEventType: 'Lock',
              blockingPids: expect.arrayContaining([
                (blocker as unknown as { processID: number }).processID,
              ]),
            }),
          );
        },
        { timeout: 3000 },
      );
      expect(events()).toContainEqual(
        expect.objectContaining({
          trigger: 'slow_query',
          backendPid: expect.any(Number),
        }),
      );
    } finally {
      await blocker.query('rollback');
      await running;
      await blocker.end();
    }
  });

  it.each(['application', 'owner'] as const)(
    'fails safely with an %s credential supplied as the monitor credential',
    async (kind) => {
      const pool = await poolOf(
        100,
        kind === 'application' ? database.url : database.ownerUrl,
      );
      await pool.query('select pg_sleep(1)').catch(() => undefined);
      await vi.waitFor(() =>
        expect(events()).toContainEqual(
          expect.objectContaining({
            captureStatus: 'unavailable',
            reason: 'monitor_role_required',
          }),
        ),
        { timeout: 3000 },
      );
      expect((await pool.query('select 42 as n')).rows[0]).toEqual({ n: 42 });
    },
  );
});
