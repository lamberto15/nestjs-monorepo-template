import type { ConfigService } from '@nestjs/config';
import { InMemoryDisk, type StorageDisk } from '@nestjs/storage';
import { LogMailTransport, type MailTransport } from '@nestjs/mail';
import type { Redis } from 'ioredis';
import type { DatabaseHealth } from '../../core/database/database-health.js';
import { REDACTED } from '../../core/logging/redaction.js';
import { OpsDiagnostics } from './ops-diagnostics.service.js';
import type { OpsQueues } from './ops-queues.service.js';

function diagnostics({
  env = {},
  ping = async () => undefined,
  workers = 1,
  disk = new InMemoryDisk(),
}: {
  env?: Record<string, unknown>;
  ping?: () => Promise<void>;
  workers?: number;
  disk?: StorageDisk;
} = {}) {
  const values: Record<string, unknown> = {
    NODE_ENV: 'development',
    MAIL_TRANSPORT: 'file',
    STORAGE_DRIVER: 'local',
    REALTIME: true,
    ...env,
  };
  const config = { get: (key: string) => values[key] } as ConfigService<
    never,
    true
  >;
  const redis = {
    status: 'ready',
    ping: async () => 'PONG',
  } as unknown as Redis;
  const queues = {
    workers: async () => [{ name: 'mail', workers }],
  } as unknown as OpsQueues;
  return new OpsDiagnostics(
    config as never,
    { ping } as unknown as DatabaseHealth,
    redis,
    queues,
    new LogMailTransport() as MailTransport,
    disk,
  );
}

const byCheck = async (service: OpsDiagnostics) =>
  Object.fromEntries(
    (await service.overview()).map((item) => [item.check, item]),
  );

describe('OpsDiagnostics', () => {
  it('tells disabled, unconfigured and unavailable apart', async () => {
    const items = await byCheck(
      diagnostics({
        env: { NODE_ENV: 'production', MAIL_TRANSPORT: 'log', REALTIME: false },
        workers: 0,
      }),
    );
    expect(items.realtime).toMatchObject({
      state: 'disabled',
      testable: false,
    });
    expect(items.mail).toMatchObject({
      state: 'unconfigured',
      driver: 'log',
      testable: false,
    });
    expect(items.workers.state).toBe('unavailable');
    expect(items.workers.hint).toContain('APP_ROLE=worker');
    expect(items.database.state).toBe('ok');
    expect(items.storage.state).toBe('configured');
  });

  it('masks a secret in a failure and never throws for one', async () => {
    const token = `tok-${Date.now()}-abcdefgh`;
    const service = diagnostics({
      ping: async () => {
        throw new Error(`refused: Authorization: Bearer ${token}`);
      },
    });
    const { database } = await byCheck(service);
    expect(database.state).toBe('unavailable');
    expect(database.detail).toBe(`refused: Authorization: Bearer ${REDACTED}`);
    const result = await service.test('database');
    expect(result.ok).toBe(false);
    expect(result.detail).not.toContain(token);
  });

  it('probes storage with a file it deletes again', async () => {
    const disk = new InMemoryDisk();
    const result = await diagnostics({ disk }).test('storage');
    expect(result.ok).toBe(true);
    expect((await disk.list({ prefix: 'ops/' })).items).toEqual([]);
  });

  it('refuses a test there is nothing safe to run, or an unknown check', async () => {
    const service = diagnostics({ env: { REALTIME: false } });
    await expect(service.test('realtime')).rejects.toMatchObject({
      response: { code: 'not_testable' },
    });
    // The file transport: no SMTP to connect to.
    await expect(service.test('mail')).rejects.toMatchObject({
      response: { code: 'not_testable' },
    });
    await expect(service.test('nope')).rejects.toThrow('No diagnostic');
  });
});
