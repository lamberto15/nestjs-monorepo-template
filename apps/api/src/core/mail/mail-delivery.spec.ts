import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Redis } from 'ioredis';
import { Registry } from 'prom-client';
import type { MetricsService } from '../metrics/metrics.service.js';
import {
  MailDeliveryGate,
  type MailDelivery,
  type MailDeliveryMode,
} from './mail-delivery.js';
import { EssentialMail } from './mail-suppression.js';

class NoticeMail {}
@EssentialMail()
class ResetMail {}

/** Redis's INCR, EXPIRE and DECR, in memory. */
function fakeRedis() {
  const store = new Map<string, number>();
  const step = (key: string, by: number) => {
    const value = (store.get(key) ?? 0) + by;
    store.set(key, value);
    return value;
  };
  const redis = {
    multi() {
      const ops: (() => unknown)[] = [];
      const chain = {
        incr: (key: string) => (ops.push(() => step(key, 1)), chain),
        expire: () => (ops.push(() => 1), chain),
        exec: async () => ops.map((op) => [null, op()]),
      };
      return chain;
    },
    decr: async (key: string) => step(key, -1),
  };
  return { redis: redis as unknown as Redis, store };
}

function gateWith(
  options: {
    mode?: MailDeliveryMode | (() => Promise<MailDeliveryMode>);
    limit?: number;
    reserve?: number;
  } = {},
) {
  const { redis, store } = fakeRedis();
  const registry = new Registry();
  const env: Record<string, number> = {
    MAIL_DAILY_LIMIT: options.limit ?? 0,
    MAIL_DAILY_ESSENTIAL_RESERVE: options.reserve ?? 0,
  };
  const delivery: MailDelivery | undefined =
    options.mode === undefined
      ? undefined
      : {
          mode:
            typeof options.mode === 'function'
              ? options.mode
              : async () => options.mode as MailDeliveryMode,
        };
  const gate = new MailDeliveryGate(
    { get: (key: string) => env[key] } as unknown as ConfigService<never, true>,
    redis,
    { registry } as unknown as MetricsService,
    delivery,
  );
  const withheld = async (reason: string) =>
    (await registry.getSingleMetric('mail_withheld_total')!.get()).values.find(
      (v) => v.labels.reason === reason,
    )?.value;
  return { gate, store, withheld };
}

describe('MailDeliveryGate', () => {
  const day = new Date('2026-10-27T12:00:00Z');

  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('lets every mail through with no mode and no limit', async () => {
    const { gate, store } = gateWith();
    expect(await gate.admit(NoticeMail, day)).toBe(true);
    expect(await gate.admit(ResetMail, day)).toBe(true);
    expect(store.size).toBe(0);
  });

  it('keeps all but essential mail back in `essential` mode', async () => {
    const { gate, withheld } = gateWith({ mode: 'essential' });
    expect(await gate.admit(NoticeMail, day)).toBe(false);
    expect(await gate.admit(ResetMail, day)).toBe(true);
    expect(await withheld('policy')).toBe(1);
  });

  it('keeps every mail back in `off` mode', async () => {
    const { gate, withheld } = gateWith({ mode: 'off' });
    expect(await gate.admit(NoticeMail, day)).toBe(false);
    expect(await gate.admit(ResetMail, day)).toBe(false);
    expect(await withheld('policy')).toBe(2);
  });

  it('stops non-essential mail at the limit minus the reserve; essential mail still goes', async () => {
    const { gate, store, withheld } = gateWith({ limit: 3, reserve: 1 });
    expect(await gate.admit(NoticeMail, day)).toBe(true);
    expect(await gate.admit(NoticeMail, day)).toBe(true);
    expect(await gate.admit(NoticeMail, day)).toBe(false);
    // The withheld one used none of the allowance.
    expect(store.get('mail:queued:2026-10-27')).toBe(2);
    expect(await gate.admit(ResetMail, day)).toBe(true);
    expect(await gate.admit(ResetMail, day)).toBe(true);
    expect(store.get('mail:queued:2026-10-27')).toBe(4);
    expect(await withheld('budget')).toBe(1);
  });

  it('counts each UTC day apart', async () => {
    const { gate } = gateWith({ limit: 1, reserve: 0 });
    expect(await gate.admit(NoticeMail, day)).toBe(true);
    expect(await gate.admit(NoticeMail, day)).toBe(false);
    expect(await gate.admit(NoticeMail, new Date('2026-10-28T00:00:01Z'))).toBe(
      true,
    );
  });

  it('lets mail through when the mode can’t be read', async () => {
    const { gate } = gateWith({
      mode: async () => {
        throw new Error('settings down');
      },
    });
    expect(await gate.admit(NoticeMail, day)).toBe(true);
  });
});
