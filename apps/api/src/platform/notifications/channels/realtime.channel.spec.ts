import type { Principal } from '../../../iam/auth/principal.js';
import type { NotificationDelivery } from '../notification.types.js';
import { RealtimeChannel } from './realtime.channel.js';

const T1 = '0198a7c2-0000-7000-8000-000000000001';
const T2 = '0198a7c2-0000-7000-8000-000000000002';
const user = (id: string) => ({ kind: 'user', id }) as Principal;

const delivery = (id: string, tenantId: string | null) =>
  ({
    notification: { id: 'n', tenantId },
    recipient: user(id),
    rendered: { locale: 'en' },
  }) as unknown as NotificationDelivery;

describe('RealtimeChannel', () => {
  const setup = () => {
    const realtime = { toPrincipal: vi.fn() };
    const notifications = {
      view: vi.fn(() => ({})),
      announceUnread: vi.fn(() => Promise.resolve()),
    };
    const system = {
      run: vi.fn((_job: unknown, work: () => Promise<unknown>) => work()),
    };
    const channel = new RealtimeChannel(
      realtime as never,
      notifications as never,
      system as never,
      { register: vi.fn() } as never,
    );
    return { channel, realtime, notifications };
  };

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('emits each notification at once and the unread count once a window', async () => {
    const { channel, realtime, notifications } = setup();
    for (let i = 0; i < 3; i++) {
      await channel.afterCommit(delivery('a', T1));
    }
    expect(realtime.toPrincipal).toHaveBeenCalledTimes(3);
    expect(notifications.announceUnread).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(notifications.announceUnread).toHaveBeenCalledTimes(1);
    // A call after the timer fired starts a new window.
    await channel.afterCommit(delivery('a', T1));
    await vi.advanceTimersByTimeAsync(1000);
    expect(notifications.announceUnread).toHaveBeenCalledTimes(2);
  });

  it('announces once per recipient and tenant', async () => {
    const { channel, notifications } = setup();
    await channel.afterCommit(delivery('a', T1));
    await channel.afterCommit(delivery('a', T2));
    await channel.afterCommit(delivery('b', T1));
    await vi.advanceTimersByTimeAsync(1000);
    expect(notifications.announceUnread).toHaveBeenCalledTimes(3);
  });

  it('logs an announce that fails instead of throwing', async () => {
    const { channel, notifications } = setup();
    notifications.announceUnread.mockRejectedValueOnce(new Error('down'));
    await channel.afterCommit(delivery('a', T1));
    await expect(vi.advanceTimersByTimeAsync(1000)).resolves.toBeUndefined();
    expect(notifications.announceUnread).toHaveBeenCalledTimes(1);
  });
});
