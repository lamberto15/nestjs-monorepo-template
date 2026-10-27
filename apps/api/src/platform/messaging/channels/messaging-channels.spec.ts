import type { Queue } from 'bullmq';
import type { NotificationChannelRegistry } from '../../notifications/notification-channel.registry.js';
import type { NotificationDelivery } from '../../notifications/notification.types.js';
import type { MessagingService } from '../messaging.service.js';
import { PushChannel } from './push.channel.js';
import { SmsChannel } from './sms.channel.js';

describe('push and SMS channels', () => {
  const delivery = (quietUntil?: Date): NotificationDelivery =>
    ({
      notification: { id: 'n1', tenantId: 't1', link: null },
      recipient: { kind: 'user', id: 'u1', tenantId: 't1' },
      setting: true,
      rendered: { locale: 'en', title: 'Title', body: 'Body' },
      ...(quietUntil ? { quietUntil } : {}),
    }) as unknown as NotificationDelivery;

  const registry = {
    register: vi.fn(),
  } as unknown as NotificationChannelRegistry;
  const messaging = {
    deviceIdsOf: async () => ['d1', 'd2'],
    hasSendablePhone: async () => true,
  } as unknown as MessagingService;

  function queue() {
    return { add: vi.fn(async () => undefined) };
  }

  it('queues one push job per device, with deterministic ids, before the transaction', async () => {
    const q = queue();
    const channel = new PushChannel(
      {} as never,
      q as unknown as Queue,
      messaging,
      registry,
    );
    await channel.beforeTransaction(delivery(), new AbortController().signal);
    expect(q.add.mock.calls.map((call) => (call as unknown[])[2])).toEqual([
      { jobId: 'push-n1-d1' },
      { jobId: 'push-n1-d2' },
    ]);
  });

  it('queues the SMS under the notification’s job id', async () => {
    const q = queue();
    const channel = new SmsChannel(
      {} as never,
      q as unknown as Queue,
      messaging,
      registry,
    );
    await channel.beforeTransaction(delivery(), new AbortController().signal);
    expect(q.add).toHaveBeenCalledWith('sms', expect.anything(), {
      jobId: 'sms-n1',
    });
  });

  it('lets a Redis failure through and stops on an aborted signal', async () => {
    const q = queue();
    q.add.mockRejectedValueOnce(new Error('redis down'));
    const channel = new SmsChannel(
      {} as never,
      q as unknown as Queue,
      messaging,
      registry,
    );
    await expect(
      channel.beforeTransaction(delivery(), new AbortController().signal),
    ).rejects.toThrow('redis down');
    const controller = new AbortController();
    q.add.mockImplementationOnce(() => new Promise<undefined>(() => {}));
    const pending = channel.beforeTransaction(delivery(), controller.signal);
    const outcome = expect(pending).rejects.toThrow('timed out');
    await vi.waitFor(() => expect(q.add).toHaveBeenCalledTimes(2));
    controller.abort(new Error('timed out'));
    await outcome;
  });
});
