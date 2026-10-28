import { Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { Registry } from 'prom-client';
import type { MetricsService } from '../metrics/metrics.service.js';
import type { QuotaCounter, TenantQuotas } from '../tenancy/tenant-quotas.js';
import {
  type MailBudget,
  MailDeliveryGate,
  type MailDelivery,
  type MailDeliveryMode,
} from './mail-delivery.js';
import { EssentialMail } from './mail-suppression.js';

const scope = vi.hoisted(() => ({ tenantId: null as string | null }));
vi.mock('../tenancy/tenant-scope.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../tenancy/tenant-scope.js')>()),
  currentTenantId: () => scope.tenantId,
}));

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
    get: async (key: string) => store.get(key)?.toString() ?? null,
  };
  return { redis: redis as unknown as Redis, store };
}

function gateWith(
  options: {
    mode?: MailDeliveryMode | (() => Promise<MailDeliveryMode>);
    budget?: Partial<MailBudget> | (() => Promise<MailBudget>);
  } = {},
) {
  const { redis, store } = fakeRedis();
  const registry = new Registry();
  const budget = options.budget;
  const delivery: MailDelivery | undefined =
    options.mode === undefined && budget === undefined
      ? undefined
      : {
          mode:
            typeof options.mode === 'function'
              ? options.mode
              : async () => (options.mode as MailDeliveryMode) ?? 'all',
          budget:
            typeof budget === 'function'
              ? budget
              : async () => ({
                  daily: null,
                  tenantDaily: null,
                  essentialOnlyPercent: 100,
                  ...budget,
                }),
        };
  const counters = new Map<string, QuotaCounter>();
  const gauges = new Map<string, () => Promise<unknown>>();
  const gate = new MailDeliveryGate(
    redis,
    {
      registry,
      collect: (name: string, _help: string, read: () => Promise<unknown>) =>
        gauges.set(name, read),
    } as unknown as MetricsService,
    {
      count: (resource: string, counter: QuotaCounter) =>
        counters.set(resource, counter),
    } as unknown as TenantQuotas,
    delivery,
  );
  const withheld = async (reason: string) =>
    (await registry.getSingleMetric('mail_withheld_total')!.get()).values.find(
      (v) => v.labels.reason === reason,
    )?.value;
  return { gate, store, withheld, counters, gauges };
}

describe('MailDeliveryGate', () => {
  const day = new Date('2026-10-27T12:00:00Z');

  beforeEach(() => {
    scope.tenantId = null;
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("gauges today's share of the deployment's budget, absent without one", async () => {
    vi.useFakeTimers({ now: day, toFake: ['Date'] });
    const { gate, gauges } = gateWith({ budget: { daily: 4 } });
    await gate.admit(NoticeMail, { now: day });
    expect(await gauges.get('mail_budget_used_ratio')!()).toEqual([
      { value: 0.25 },
    ]);
    expect(await gateWith().gauges.get('mail_budget_used_ratio')!()).toEqual(
      [],
    );
    vi.useRealTimers();
  });

  it('lets every mail through with no mode and no budget, counting it', async () => {
    const { gate, store } = gateWith();
    expect(await gate.admit(NoticeMail, { now: day })).toBe(true);
    expect(await gate.admit(ResetMail, { now: day })).toBe(true);
    expect(store.get('mail:queued:2026-10-27')).toBe(2);
  });

  it('keeps all but essential mail back in `essential` mode', async () => {
    const { gate, withheld } = gateWith({ mode: 'essential' });
    expect(await gate.admit(NoticeMail, { now: day })).toBe(false);
    expect(await gate.admit(ResetMail, { now: day })).toBe(true);
    expect(await withheld('policy')).toBe(1);
  });

  it('lets a mail sent as essential through in `essential` mode and past the budget', async () => {
    const policy = gateWith({ mode: 'essential' });
    expect(
      await policy.gate.admit(NoticeMail, { essential: true, now: day }),
    ).toBe(true);
    const budget = gateWith({ budget: { daily: 1 } });
    expect(await budget.gate.admit(NoticeMail, { now: day })).toBe(true);
    expect(
      await budget.gate.admit(NoticeMail, { essential: true, now: day }),
    ).toBe(true);
    expect(await budget.gate.admit(NoticeMail, { now: day })).toBe(false);
  });

  it('keeps every mail back in `off` mode', async () => {
    const { gate, withheld } = gateWith({ mode: 'off' });
    expect(await gate.admit(NoticeMail, { now: day })).toBe(false);
    expect(await gate.admit(ResetMail, { now: day })).toBe(false);
    expect(await withheld('policy')).toBe(2);
  });

  it('stops non-essential mail past the percentage of the daily limit; essential mail still goes', async () => {
    const { gate, store, withheld } = gateWith({
      budget: { daily: 4, essentialOnlyPercent: 50 },
    });
    expect(await gate.admit(NoticeMail, { now: day })).toBe(true);
    expect(await gate.admit(NoticeMail, { now: day })).toBe(true);
    expect(await gate.admit(NoticeMail, { now: day })).toBe(false);
    // The withheld one used none of the allowance.
    expect(store.get('mail:queued:2026-10-27')).toBe(2);
    expect(await gate.admit(ResetMail, { now: day })).toBe(true);
    expect(await gate.admit(ResetMail, { now: day })).toBe(true);
    expect(await gate.admit(ResetMail, { now: day })).toBe(true);
    expect(store.get('mail:queued:2026-10-27')).toBe(5);
    expect(await withheld('budget')).toBe(1);
  });

  it("stops a tenant's non-essential mail past its own budget while the deployment's has room", async () => {
    scope.tenantId = 'tenant-a';
    const { gate, store, withheld } = gateWith({
      budget: { daily: 100, tenantDaily: 2, essentialOnlyPercent: 100 },
    });
    expect(await gate.admit(NoticeMail, { now: day })).toBe(true);
    expect(await gate.admit(NoticeMail, { now: day })).toBe(true);
    expect(await gate.admit(NoticeMail, { now: day })).toBe(false);
    expect(await gate.admit(ResetMail, { now: day })).toBe(true);
    // Both counters lost the withheld one.
    expect(store.get('tenant:tenant-a:mail:queued:2026-10-27')).toBe(3);
    expect(store.get('mail:queued:2026-10-27')).toBe(3);
    expect(await withheld('tenant_budget')).toBe(1);
    // Another tenant has its own count.
    scope.tenantId = 'tenant-b';
    expect(await gate.admit(NoticeMail, { now: day })).toBe(true);
  });

  it("reports a tenant's mails queued today as its `mailsPerDay` usage", async () => {
    scope.tenantId = 'tenant-a';
    const { gate, counters } = gateWith();
    await gate.admit(NoticeMail);
    await gate.admit(ResetMail);
    const used = counters.get('mailsPerDay')!;
    expect(await used(undefined as never, 'tenant-a')).toBe(2);
    expect(await used(undefined as never, 'tenant-b')).toBe(0);
  });

  it("stops every tenant's non-essential mail at the deployment's budget", async () => {
    scope.tenantId = 'tenant-a';
    const { gate, withheld } = gateWith({
      budget: { daily: 1, tenantDaily: 50, essentialOnlyPercent: 100 },
    });
    expect(await gate.admit(NoticeMail, { now: day })).toBe(true);
    scope.tenantId = 'tenant-b';
    expect(await gate.admit(NoticeMail, { now: day })).toBe(false);
    expect(await withheld('budget')).toBe(1);
  });

  it('counts each UTC day apart', async () => {
    const { gate } = gateWith({ budget: { daily: 1 } });
    expect(await gate.admit(NoticeMail, { now: day })).toBe(true);
    expect(await gate.admit(NoticeMail, { now: day })).toBe(false);
    expect(
      await gate.admit(NoticeMail, { now: new Date('2026-10-28T00:00:01Z') }),
    ).toBe(true);
  });

  it('lets mail through when the budget can’t be read', async () => {
    const { gate } = gateWith({
      budget: async () => {
        throw new Error('settings down');
      },
    });
    expect(await gate.admit(NoticeMail, { now: day })).toBe(true);
  });

  it('lets mail through when the mode can’t be read', async () => {
    const { gate } = gateWith({
      mode: async () => {
        throw new Error('settings down');
      },
    });
    expect(await gate.admit(NoticeMail, { now: day })).toBe(true);
  });
});
