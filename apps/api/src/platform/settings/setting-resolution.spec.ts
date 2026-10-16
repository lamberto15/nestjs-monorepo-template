import { z } from 'zod';
import type { Principal } from '../../iam/auth/principal.js';
import { resolveSetting, rolloutBucket } from './setting-resolution.js';
import { flag, setting, type SettingOverride } from './setting.types.js';

const user: Principal = {
  kind: 'user',
  id: '0000-u1',
  email: 'u@example.com',
  name: 'U',
  emailVerified: true,
  locale: null,
  timezone: null,
};
const limit = setting({
  key: 'notes.limit',
  label: 'Limit',
  schema: z.int(),
  default: 10,
  scopes: ['global', 'orgUnit', 'user'],
});
const theme = setting({
  key: 'ui.theme',
  label: 'Theme',
  schema: z.enum(['light', 'dark']),
  default: 'light',
  scopes: ['global', 'user'],
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
  it('is the default without overrides, the global one with it', () => {
    expect(resolveSetting(limit, [], user, [])).toEqual({
      value: 10,
      source: 'default',
    });
    expect(
      resolveSetting(
        limit,
        [override('notes.limit', 'global', '', 20)],
        user,
        [],
      ),
    ).toEqual({ value: 20, source: 'global' });
    expect(
      resolveSetting(
        limit,
        [override('notes.limit', 'global', '', 20)],
        null,
        [],
      ),
    ).toEqual({ value: 20, source: 'global' });
  });

  it("prefers the principal's own value, then one of their org units', in order", () => {
    const overrides = [
      override('notes.limit', 'global', '', 20),
      override('notes.limit', 'orgUnit', 'unit-b', 30),
      override('notes.limit', 'orgUnit', 'unit-a', 25),
      override('notes.limit', 'user', 'user:0000-u1', 5),
    ];
    expect(
      resolveSetting(limit, overrides, user, ['unit-a', 'unit-b']),
    ).toEqual({ value: 5, source: 'user' });
    expect(
      resolveSetting(limit, overrides.slice(0, 3), user, ['unit-a', 'unit-b']),
    ).toEqual({ value: 25, source: 'orgUnit' });
    expect(
      resolveSetting(limit, overrides.slice(0, 3), user, ['unit-b']),
    ).toEqual({ value: 30, source: 'orgUnit' });
    expect(resolveSetting(limit, overrides.slice(0, 3), user, [])).toEqual({
      value: 20,
      source: 'global',
    });
  });

  it('ignores a scope the declaration does not allow', () => {
    const overrides = [override('ui.theme', 'orgUnit', 'unit-a', 'dark')];
    expect(resolveSetting(theme, overrides, user, ['unit-a'])).toEqual({
      value: 'light',
      source: 'default',
    });
  });

  it('rolls a flag out to a stable share of principals', () => {
    const half = [override('notes.richText', 'global', '', null, 50)];
    const bucket = rolloutBucket('notes.richText', 'user:0000-u1');
    expect(bucket).toBeGreaterThanOrEqual(0);
    expect(bucket).toBeLessThan(100);
    expect(resolveSetting(richText, half, user, [])).toEqual({
      value: bucket < 50,
      source: 'rollout',
    });
    expect(
      resolveSetting(
        richText,
        [override('notes.richText', 'global', '', null, 100)],
        user,
        [],
      ),
    ).toEqual({ value: true, source: 'rollout' });
    expect(
      resolveSetting(
        richText,
        [override('notes.richText', 'global', '', null, 0)],
        user,
        [],
      ),
    ).toEqual({ value: false, source: 'rollout' });
    // Without a principal, a rollout is nobody's: the default.
    expect(resolveSetting(richText, half, null, [])).toEqual({
      value: false,
      source: 'default',
    });
    // A value beats the rollout; the principal's own beats both.
    expect(
      resolveSetting(
        richText,
        [override('notes.richText', 'global', '', true, 50)],
        user,
        [],
      ),
    ).toEqual({ value: true, source: 'global' });
    expect(
      resolveSetting(
        richText,
        [...half, override('notes.richText', 'user', 'user:0000-u1', true)],
        user,
        [],
      ),
    ).toEqual({ value: true, source: 'user' });
  });

  it('spreads principals across buckets', () => {
    const on = Array.from(
      { length: 1000 },
      (_, i) => rolloutBucket('k', `user:${i}`) < 50,
    ).filter(Boolean).length;
    expect(on).toBeGreaterThan(400);
    expect(on).toBeLessThan(600);
  });
});
