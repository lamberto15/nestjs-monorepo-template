import { z } from 'zod';
import type { Principal } from '../../iam/auth/principal.js';
import { resolveSetting, rolloutBucket } from './setting-resolution.js';
import { flag, setting, type SettingOverride } from './setting.types.js';

const TENANT = '0000-t1';
const user: Principal = {
  kind: 'user',
  id: '0000-u1',
  email: 'u@example.com',
  name: 'U',
  emailVerified: true,
  locale: null,
  timezone: null,
  tenantId: TENANT,
};
const limit = setting({
  key: 'notes.limit',
  label: 'Limit',
  schema: z.int(),
  default: 10,
  scopes: ['tenant', 'unit', 'user'],
});
const theme = setting({
  key: 'ui.theme',
  label: 'Theme',
  schema: z.enum(['light', 'dark']),
  default: 'light',
  scopes: ['tenant', 'user'],
});
const richText = flag({
  key: 'notes.richText',
  label: 'Rich text',
  default: false,
});

const override = (
  key: string,
  scope: SettingOverride['scope'],
  scopeId: string,
  value: unknown,
  rollout: number | null = null,
): SettingOverride => ({ key, scope, scopeId, value, rollout });

describe('resolveSetting', () => {
  it('is the default without overrides, the tenant value with it', () => {
    expect(resolveSetting(limit, [], user, [], TENANT)).toEqual({
      value: 10,
      source: 'default',
    });
    expect(
      resolveSetting(
        limit,
        [override('notes.limit', 'tenant', '', 20)],
        user,
        [],
        TENANT,
      ),
    ).toEqual({ value: 20, source: 'tenant' });
    expect(
      resolveSetting(
        limit,
        [override('notes.limit', 'tenant', '', 20)],
        null,
        [],
        TENANT,
      ),
    ).toEqual({ value: 20, source: 'tenant' });
  });

  it("prefers the principal's own value, then one of their units', in order", () => {
    const overrides = [
      override('notes.limit', 'tenant', '', 20),
      override('notes.limit', 'unit', 'unit-b', 30),
      override('notes.limit', 'unit', 'unit-a', 25),
      override('notes.limit', 'user', 'user:0000-u1', 5),
    ];
    expect(
      resolveSetting(limit, overrides, user, ['unit-a', 'unit-b'], TENANT),
    ).toEqual({ value: 5, source: 'user' });
    expect(
      resolveSetting(
        limit,
        overrides.slice(0, 3),
        user,
        ['unit-a', 'unit-b'],
        TENANT,
      ),
    ).toEqual({ value: 25, source: 'unit' });
    expect(
      resolveSetting(limit, overrides.slice(0, 3), user, ['unit-b'], TENANT),
    ).toEqual({ value: 30, source: 'unit' });
    expect(
      resolveSetting(limit, overrides.slice(0, 3), user, [], TENANT),
    ).toEqual({
      value: 20,
      source: 'tenant',
    });
  });

  it('ignores a scope the declaration does not allow', () => {
    const overrides = [override('ui.theme', 'unit', 'unit-a', 'dark')];
    expect(resolveSetting(theme, overrides, user, ['unit-a'], TENANT)).toEqual({
      value: 'light',
      source: 'default',
    });
  });

  it('rolls a flag out to a stable share of principals', () => {
    const half = [override('notes.richText', 'tenant', '', null, 50)];
    const bucket = rolloutBucket('notes.richText', TENANT, 'user:0000-u1');
    expect(bucket).toBeGreaterThanOrEqual(0);
    expect(bucket).toBeLessThan(100);
    expect(resolveSetting(richText, half, user, [], TENANT)).toEqual({
      value: bucket < 50,
      source: 'rollout',
    });
    expect(
      resolveSetting(
        richText,
        [override('notes.richText', 'tenant', '', null, 100)],
        user,
        [],
        TENANT,
      ),
    ).toEqual({ value: true, source: 'rollout' });
    expect(
      resolveSetting(
        richText,
        [override('notes.richText', 'tenant', '', null, 0)],
        user,
        [],
        TENANT,
      ),
    ).toEqual({ value: false, source: 'rollout' });
    // Without a principal, a rollout is nobody's: the default.
    expect(resolveSetting(richText, half, null, [], TENANT)).toEqual({
      value: false,
      source: 'default',
    });
    // A value beats the rollout; the principal's own beats both.
    expect(
      resolveSetting(
        richText,
        [override('notes.richText', 'tenant', '', true, 50)],
        user,
        [],
        TENANT,
      ),
    ).toEqual({ value: true, source: 'tenant' });
    expect(
      resolveSetting(
        richText,
        [...half, override('notes.richText', 'user', 'user:0000-u1', true)],
        user,
        [],
        TENANT,
      ),
    ).toEqual({ value: true, source: 'user' });
  });

  it('spreads principals across buckets', () => {
    const on = Array.from(
      { length: 1000 },
      (_, i) => rolloutBucket('k', TENANT, `user:${i}`) < 50,
    ).filter(Boolean).length;
    expect(on).toBeGreaterThan(400);
    expect(on).toBeLessThan(600);
  });
});

describe('rollouts per tenant', () => {
  it("draws each tenant apart: the same principal can be in one tenant's share and not another's", () => {
    const principals = Array.from({ length: 200 }, (_, i) => `user:${i}`);
    const inA = principals.map((p) => rolloutBucket('k', 'tenant-a', p) < 50);
    const inB = principals.map((p) => rolloutBucket('k', 'tenant-b', p) < 50);
    expect(inA.some((on, i) => on !== inB[i])).toBe(true);
  });

  it('has no rollout without a tenant: the default', () => {
    const half = [override('notes.richText', 'tenant', '', null, 100)];
    expect(resolveSetting(richText, half, user, [], null)).toEqual({
      value: false,
      source: 'default',
    });
  });
});

describe('platform values (set by the operators for every tenant)', () => {
  const tenantOn = [override('notes.richText', 'tenant', '', true)];
  const mine = [override('notes.richText', 'user', 'user:0000-u1', true)];

  it('is the default of every tenant that set nothing, before the code default', () => {
    expect(
      resolveSetting(richText, [], user, [], TENANT, {
        value: true,
        enforced: false,
        rollout: null,
      }),
    ).toEqual({ value: true, source: 'platform' });
  });

  it("gives way to a tenant's, a unit's or a principal's own value, and a tenant's rollout", () => {
    const platform = { value: false, enforced: false, rollout: null };
    expect(
      resolveSetting(richText, tenantOn, user, [], TENANT, platform),
    ).toEqual({ value: true, source: 'tenant' });
    expect(resolveSetting(richText, mine, user, [], TENANT, platform)).toEqual({
      value: true,
      source: 'user',
    });
    const all = [override('notes.richText', 'tenant', '', null, 100)];
    expect(resolveSetting(richText, all, user, [], TENANT, platform)).toEqual({
      value: true,
      source: 'rollout',
    });
  });

  it('beats every value when enforced (a kill switch)', () => {
    const killed = { value: false, enforced: true, rollout: null };
    for (const overrides of [tenantOn, mine]) {
      expect(
        resolveSetting(richText, overrides, user, [], TENANT, killed),
      ).toEqual({ value: false, source: 'platform' });
    }
  });

  it("rolls a flag out in every tenant that set nothing, each tenant drawn apart, below the tenant's own", () => {
    const half = { value: null, enforced: false, rollout: 50 };
    const principals = Array.from({ length: 200 }, (_, i) => ({
      kind: 'user' as const,
      id: `u${i}`,
    }));
    const drawn = (tenant: string) =>
      principals.map(
        (principal) =>
          resolveSetting(richText, [], principal, [], tenant, half).value,
      );
    const inA = drawn('tenant-a');
    expect(inA.filter(Boolean).length).toBeGreaterThan(60);
    expect(inA.filter(Boolean).length).toBeLessThan(140);
    expect(inA.some((on, i) => on !== drawn('tenant-b')[i])).toBe(true);
    expect(resolveSetting(richText, [], user, [], TENANT, half).source).toBe(
      'platform',
    );
    expect(resolveSetting(richText, tenantOn, user, [], TENANT, half)).toEqual({
      value: true,
      source: 'tenant',
    });
  });

  it('holds outside any tenant too', () => {
    expect(
      resolveSetting(limit, [], null, [], null, {
        value: 42,
        enforced: false,
        rollout: null,
      }),
    ).toEqual({ value: 42, source: 'platform' });
  });
});
