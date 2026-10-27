import type { ConfigService } from '@nestjs/config';
import type { Transaction } from '../../../core/database/drizzle.js';
import type { MailQueue } from '../../../core/mail/mail-queue.js';
import type { NotificationCatalog } from '../notification-catalog.js';
import type { NotificationChannelRegistry } from '../notification-channel.registry.js';
import type { NotificationUnsubscribeLinks } from '../notification-unsubscribe.js';
import type { NotificationDelivery } from '../notification.types.js';
import { EmailChannel } from './email.channel.js';

describe('EmailChannel', () => {
  const delivery = (setting: unknown): NotificationDelivery =>
    ({
      notification: { id: 'n1', type: 'note.published', link: null },
      recipient: {
        kind: 'user',
        id: 'u1',
        name: 'Ada',
        email: 'ada@example.com',
      },
      setting,
      rendered: { locale: 'en', title: 'Title', body: 'Body' },
    }) as unknown as NotificationDelivery;

  function channel() {
    const send = vi.fn(async () => undefined);
    const where = vi.fn(async () => undefined);
    const set = vi.fn(() => ({ where }));
    const tx = { update: vi.fn(() => ({ set })) } as unknown as Transaction;
    const instance = new EmailChannel(
      { send } as unknown as MailQueue,
      {
        get: (key: string) => (key === 'NOTIFICATIONS_DIGEST_HOUR' ? 8 : 'UTC'),
      } as unknown as ConfigService<never, true>,
      {
        declaration: () => ({ mandatory: true }),
      } as unknown as NotificationCatalog,
      {
        signType: () => 'token',
      } as unknown as NotificationUnsubscribeLinks,
      { register: vi.fn() } as unknown as NotificationChannelRegistry,
    );
    return { instance, send, set, tx };
  }

  it('queues the mail outside the transaction, under the notification’s job id', async () => {
    const { instance, send, tx } = channel();
    const signal = new AbortController().signal;
    await instance.beforeTransaction(delivery('immediate'), signal);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ locale: 'en' }),
      // The test catalog declares the type mandatory: essential for mail.delivery.
      { jobId: 'notification-n1', signal, essential: true },
    );
    expect(tx.update).not.toHaveBeenCalled();
  });

  it('does not touch the queue inside the transaction, only flags the mail as sent', async () => {
    const { instance, send, set, tx } = channel();
    await instance.inTransaction(delivery('immediate'), tx);
    expect(send).not.toHaveBeenCalled();
    expect(set).toHaveBeenCalledWith({ emailedAt: expect.any(Date) });
  });

  it('lets a queue failure through, so the relay retries the delivery', async () => {
    const { instance, send } = channel();
    send.mockRejectedValueOnce(new Error('redis down'));
    await expect(
      instance.beforeTransaction(
        delivery('immediate'),
        new AbortController().signal,
      ),
    ).rejects.toThrow('redis down');
  });

  it('queues the same job id on a retry, so the mail goes once', async () => {
    const { instance, send } = channel();
    const signal = new AbortController().signal;
    await instance.beforeTransaction(delivery('immediate'), signal);
    await instance.beforeTransaction(delivery('immediate'), signal);
    const ids = send.mock.calls.map((call) => (call as unknown[])[2]);
    expect(ids[0]).toEqual(ids[1]);
  });

  it.each(['daily', false])('queues nothing for %s', async (setting) => {
    const { instance, send } = channel();
    await instance.beforeTransaction(
      delivery(setting),
      new AbortController().signal,
    );
    expect(send).not.toHaveBeenCalled();
  });

  it('flags a digest in the transaction', async () => {
    const { instance, set, tx } = channel();
    await instance.inTransaction(delivery('daily'), tx);
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ digest: 'daily' }),
    );
  });
});
