import type { TransactionHost } from '@nestjs-cls/transactional';
import type { ConfigService } from '@nestjs/config';
import type { I18nService } from '@nestjs/i18n';
import type { OutboxHandlerContext } from '@nestjs/outbox';
import type { Transaction } from '../../core/database/drizzle.js';
import type { DrizzleTransactions } from '../../core/database/transactions.js';
import type { SystemContext } from '../../iam/access/system-context.js';
import type { UsersRepository } from '../../iam/auth/users.repository.js';
import type { SettingsService } from '../settings/settings.service.js';
import type { NotificationCatalog } from './notification-catalog.js';
import type { NotificationChannelRegistry } from './notification-channel.registry.js';
import { NotificationDeliveryHandler } from './notification-delivery.handler.js';
import type {
  NotificationChannel,
  NotificationMessage,
} from './notification.types.js';
import type { NotificationsService } from './notifications.service.js';

// The tenant context needs nestjs-cls; the handler's logic does not.
vi.mock('../../core/tenancy/tenant-job.js', () => ({
  inTenantOf: (_envelope: unknown, work: () => Promise<unknown>) => work(),
}));

describe('NotificationDeliveryHandler', () => {
  const payload = {
    notificationId: 'n1',
    tenantId: null,
  } as unknown as NotificationMessage;

  function setup(
    row: Record<string, unknown> = {
      id: 'n1',
      type: 't',
      recipient: 'user:u1',
    },
  ) {
    const events: string[] = [];
    let open = false;
    let committed = 0;
    const db = {
      select: () => ({ from: () => ({ where: async () => [row] }) }),
      update: () => ({
        set: () => ({
          where: async () => {
            events.push(open ? 'write' : 'write-outside');
          },
        }),
      }),
    };
    const txHost = {
      tx: db,
      withTransaction: async (work: () => Promise<unknown>) => {
        open = true;
        events.push('begin');
        try {
          const result = await work();
          events.push('commit');
          committed++;
          return result;
        } finally {
          open = false;
        }
      },
    } as unknown as TransactionHost<DrizzleTransactions>;
    const channel = {
      name: 'email',
      supports: () => true,
      beforeTransaction: vi.fn(async () => {
        events.push(open ? 'before-INSIDE' : 'before');
      }),
      inTransaction: vi.fn(async () => {
        events.push('in-transaction');
      }),
      afterCommit: vi.fn(async () => {
        events.push('after-commit');
      }),
    } satisfies NotificationChannel;
    const handler = new NotificationDeliveryHandler(
      txHost,
      {
        declaration: () => ({ urgent: true }),
        effective: () => ({}),
        render: () => ({ title: 'T', body: 'B' }),
      } as unknown as NotificationCatalog,
      { all: () => [channel] } as unknown as NotificationChannelRegistry,
      { overrides: async () => ({}) } as unknown as NotificationsService,
      {
        inTenant: async () => ({ kind: 'user', id: 'u1', tenantId: null }),
      } as unknown as UsersRepository,
      { defaultLocale: 'en' } as unknown as I18nService,
      {
        run: (_job: unknown, work: () => Promise<unknown>) => work(),
      } as unknown as SystemContext,
      { get: () => 'UTC' } as unknown as ConfigService<never, true>,
      { get: async () => 'all' } as unknown as SettingsService,
    );
    // The inbox: the first delivery of a message runs the work, a repeat does not.
    let processed = false;
    const ctx = {
      signal: new AbortController().signal,
      processInTransaction: async (
        _tx: Transaction,
        work: () => Promise<void>,
      ) => {
        if (processed) {
          return { duplicate: true };
        }
        await work();
        processed = true;
        return { duplicate: false };
      },
    } as unknown as OutboxHandlerContext<Transaction>;
    return { handler, channel, ctx, events, committed: () => committed };
  }

  it('calls the channels before the transaction opens, never inside it', async () => {
    const { handler, ctx, events } = setup();
    await handler.deliver(payload, ctx);
    expect(events).toEqual([
      'before',
      'begin',
      'in-transaction',
      'write',
      'commit',
      'after-commit',
    ]);
  });

  it('passes the relay’s abort signal to the channels', async () => {
    const { handler, channel, ctx } = setup();
    await handler.deliver(payload, ctx);
    expect(channel.beforeTransaction).toHaveBeenCalledWith(
      expect.anything(),
      ctx.signal,
    );
  });

  it('opens no transaction and commits nothing when the queue fails, and the relay retries', async () => {
    const { handler, channel, ctx, events, committed } = setup();
    channel.beforeTransaction.mockRejectedValueOnce(new Error('redis down'));
    await expect(handler.deliver(payload, ctx)).rejects.toThrow('redis down');
    expect(events).toEqual([]);
    expect(committed()).toBe(0);
    // The retry runs the whole delivery, so nothing is lost.
    await handler.deliver(payload, ctx);
    expect(events).toContain('commit');
    expect(channel.beforeTransaction).toHaveBeenCalledTimes(2);
    expect(channel.afterCommit).toHaveBeenCalledTimes(1);
  });

  it('runs the after-commit effects once the transaction committed, and not for a duplicate', async () => {
    const { handler, channel, ctx } = setup();
    await handler.deliver(payload, ctx);
    await handler.deliver(payload, ctx); // redelivered: the inbox says duplicate
    expect(channel.inTransaction).toHaveBeenCalledTimes(1);
    expect(channel.afterCommit).toHaveBeenCalledTimes(1);
  });

  it('repeats the channel call (idempotent by its job id) when the transaction failed', async () => {
    const { handler, channel, ctx } = setup();
    channel.inTransaction.mockRejectedValueOnce(new Error('db down'));
    await expect(handler.deliver(payload, ctx)).rejects.toThrow('db down');
    await handler.deliver(payload, ctx);
    expect(channel.beforeTransaction).toHaveBeenCalledTimes(2);
    expect(channel.afterCommit).toHaveBeenCalledTimes(1);
  });

  it('does nothing for a notification that was delivered already', async () => {
    const { handler, channel, ctx } = setup({
      id: 'n1',
      type: 't',
      recipient: 'user:u1',
      deliveredAt: new Date(),
    });
    await handler.deliver(payload, ctx);
    expect(channel.beforeTransaction).not.toHaveBeenCalled();
  });
});
