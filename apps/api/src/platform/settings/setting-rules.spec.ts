import { z } from 'zod';
import { resolveSetting, rolloutBucket } from './setting-resolution.js';
import {
  type FlagRule,
  parseRules,
  type RuleAttributes,
  ruleMatches,
} from './setting-rules.js';
import { flag, type SettingOverride } from './setting.types.js';

const TENANT = '0000-t1';
const ROLE = '11111111-1111-4111-8111-111111111111';
const attrs = (over: Partial<RuleAttributes> = {}): RuleAttributes => ({
  kind: 'user',
  email: 'ann@acme.com',
  locale: 'en-GB',
  roleIds: new Set([ROLE]),
  tenant: { slug: 'acme', operator: false },
  ...over,
});
const rule = (
  key: string,
  params: Record<string, unknown>,
  outcome: FlagRule['outcome'] = { value: true },
): FlagRule => ({ conditions: [{ key, params }], outcome });

describe('ruleMatches', () => {
  it('matches each condition of the catalog', () => {
    expect(
      ruleMatches(rule('principalKind', { kinds: ['user'] }), attrs()),
    ).toBe(true);
    expect(
      ruleMatches(rule('principalKind', { kinds: ['client'] }), attrs()),
    ).toBe(false);
    expect(ruleMatches(rule('role', { roleIds: [ROLE] }), attrs())).toBe(true);
    expect(
      ruleMatches(rule('emailDomain', { domains: ['acme.com'] }), attrs()),
    ).toBe(true);
    expect(ruleMatches(rule('locale', { locales: ['en'] }), attrs())).toBe(
      true,
    );
    expect(ruleMatches(rule('locale', { locales: ['de'] }), attrs())).toBe(
      false,
    );
    expect(ruleMatches(rule('tenantSlug', { slugs: ['acme'] }), attrs())).toBe(
      true,
    );
    expect(
      ruleMatches(rule('tenantOperator', { operator: true }), attrs()),
    ).toBe(false);
  });

  it('needs every condition (and)', () => {
    const both: FlagRule = {
      conditions: [
        { key: 'principalKind', params: { kinds: ['user'] } },
        { key: 'emailDomain', params: { domains: ['other.com'] } },
      ],
      outcome: { value: true },
    };
    expect(ruleMatches(both, attrs())).toBe(false);
  });

  it('matches the email domain exactly: no subdomain, no look-alike, no unverified email', () => {
    const r = rule('emailDomain', { domains: ['acme.com'] });
    expect(ruleMatches(r, attrs({ email: 'a@sub.acme.com' }))).toBe(false);
    expect(ruleMatches(r, attrs({ email: 'a@evilacme.com' }))).toBe(false);
    expect(ruleMatches(r, attrs({ email: 'a@acme.com.evil.io' }))).toBe(false);
    expect(ruleMatches(r, attrs({ email: 'a@ACME.com' }))).toBe(true);
    expect(ruleMatches(r, attrs({ email: null }))).toBe(false);
    expect(ruleMatches(r, attrs({ kind: 'client' }))).toBe(false);
  });

  it('fails closed on what it cannot evaluate', () => {
    // An attribute the principal does not have.
    expect(
      ruleMatches(rule('locale', { locales: ['en'] }), attrs({ locale: null })),
    ).toBe(false);
    expect(
      ruleMatches(
        rule('role', { roleIds: [ROLE] }),
        attrs({ roleIds: undefined }),
      ),
    ).toBe(false);
    expect(
      ruleMatches(
        rule('tenantSlug', { slugs: ['acme'] }),
        attrs({ tenant: null }),
      ),
    ).toBe(false);
    // A key this code does not know, inherited names, malformed params, no conditions.
    expect(ruleMatches(rule('plan', { plans: ['pro'] }), attrs())).toBe(false);
    expect(ruleMatches(rule('constructor', {}), attrs())).toBe(false);
    expect(
      ruleMatches(rule('emailDomain', { domains: 'acme.com' }), attrs()),
    ).toBe(false);
    expect(
      ruleMatches(
        rule('principalKind', { kinds: ['user'], extra: 1 }),
        attrs(),
      ),
    ).toBe(false);
    expect(
      ruleMatches({ conditions: [], outcome: { value: true } }, attrs()),
    ).toBe(false);
    // One unknown condition sinks the whole rule even when the others hold.
    expect(
      ruleMatches(
        {
          conditions: [
            { key: 'principalKind', params: { kinds: ['user'] } },
            { key: 'plan', params: {} },
          ],
          outcome: { value: true },
        },
        attrs(),
      ),
    ).toBe(false);
  });
});

describe('parseRules', () => {
  it('normalises domains and languages to lower case', () => {
    const parsed = parseRules(
      [
        {
          conditions: [
            { key: 'emailDomain', params: { domains: ['ACME.com'] } },
          ],
          outcome: { rollout: 20 },
        },
      ],
      'tenant',
    );
    expect(parsed).toEqual({
      ok: true,
      rules: [
        {
          conditions: [
            { key: 'emailDomain', params: { domains: ['acme.com'] } },
          ],
          outcome: { rollout: 20 },
        },
      ],
    });
  });

  it('refuses unknown keys, bad params, role at the platform scope, empty and oversized lists', () => {
    const bad = (rules: unknown, scope: 'tenant' | 'platform' = 'tenant') => {
      const parsed = parseRules(rules, scope);
      expect(parsed.ok).toBe(false);
      return parsed.ok ? [] : parsed.issues.map((i) => i.path);
    };
    expect(
      bad([
        { conditions: [{ key: 'plan', params: {} }], outcome: { value: true } },
      ]),
    ).toEqual(['rules.0.conditions.0.key']);
    expect(
      bad([
        {
          conditions: [{ key: 'emailDomain', params: { domains: ['nope'] } }],
          outcome: { value: true },
        },
      ])[0],
    ).toBe('rules.0.conditions.0.params.domains.0');
    expect(
      bad(
        [
          {
            conditions: [{ key: 'role', params: { roleIds: [ROLE] } }],
            outcome: { value: true },
          },
        ],
        'platform',
      ),
    ).toEqual(['rules.0.conditions.0.key']);
    expect(bad([{ conditions: [], outcome: { value: true } }])).toEqual([
      'rules.0.conditions',
    ]);
    expect(
      bad([
        {
          conditions: [{ key: 'principalKind', params: { kinds: ['user'] } }],
          outcome: { rollout: 101 },
        },
      ]).length,
    ).toBeGreaterThan(0);
    expect(
      bad(
        Array.from({ length: 21 }, () =>
          rule('principalKind', { kinds: ['user'] }),
        ),
      ),
    ).toEqual(['rules']);
  });
});

describe('rules in resolveSetting', () => {
  const beta = flag({ key: 'notes.beta', label: 'Beta', default: false });
  const user = { kind: 'user' as const, id: '0000-u1' };
  const row = (
    rules: FlagRule[],
    value: unknown = null,
    rollout: number | null = null,
  ): SettingOverride => ({
    key: beta.key,
    scope: 'tenant',
    scopeId: '',
    value,
    rollout,
    rules,
  });
  const resolve = (
    rules: FlagRule[],
    attributes: RuleAttributes | null,
    extra: {
      value?: unknown;
      platform?: Parameters<typeof resolveSetting>[5];
    } = {},
  ) =>
    resolveSetting(
      beta,
      [row(rules, extra.value ?? null)],
      user,
      [],
      TENANT,
      extra.platform,
      attributes,
    );

  it('decides before the tenant value, first match wins', () => {
    const rules = [
      rule('emailDomain', { domains: ['acme.com'] }, { value: false }),
      rule('principalKind', { kinds: ['user'] }),
    ];
    expect(resolve(rules, attrs(), { value: true })).toEqual({
      value: false,
      source: 'rule',
    });
    expect(
      resolve(rules, attrs({ email: 'x@other.com' }), { value: false }),
    ).toEqual({ value: true, source: 'rule' });
  });

  it('falls through to the plain value when no rule matches', () => {
    const rules = [rule('principalKind', { kinds: ['client'] })];
    expect(resolve(rules, attrs(), { value: true })).toEqual({
      value: true,
      source: 'tenant',
    });
    expect(resolve(rules, attrs())).toEqual({
      value: false,
      source: 'default',
    });
  });

  it('matches nobody without attributes (a guest, a job)', () => {
    expect(resolve([rule('principalKind', { kinds: ['user'] })], null)).toEqual(
      { value: false, source: 'default' },
    );
  });

  it('rolls out inside the matched group, off for the rest of it', () => {
    const half = [rule('principalKind', { kinds: ['user'] }, { rollout: 50 })];
    const bucket = rolloutBucket(beta.key, TENANT, 'user:0000-u1');
    expect(resolve(half, attrs(), { value: true })).toEqual({
      value: bucket < 50,
      source: 'rule',
    });
  });

  it("keeps a unit's or principal's own value above the rules, and an enforced platform value above all", () => {
    const rules = [rule('principalKind', { kinds: ['user'] })];
    const own: SettingOverride = {
      key: beta.key,
      scope: 'user',
      scopeId: 'user:0000-u1',
      value: false,
      rollout: null,
    };
    expect(
      resolveSetting(
        beta,
        [row(rules), own],
        user,
        [],
        TENANT,
        undefined,
        attrs(),
      ),
    ).toEqual({ value: false, source: 'user' });
    const killed = { value: false, enforced: true, rollout: null };
    expect(resolve(rules, attrs(), { platform: killed })).toEqual({
      value: false,
      source: 'platform',
    });
  });

  it('applies platform rules below the tenant value and before the platform value', () => {
    const platform = {
      value: false,
      enforced: false,
      rollout: null,
      rules: [rule('tenantSlug', { slugs: ['acme'] })],
    };
    expect(
      resolveSetting(beta, [], user, [], TENANT, platform, attrs()),
    ).toEqual({ value: true, source: 'rule' });
    expect(
      resolveSetting(
        beta,
        [row([], false)],
        user,
        [],
        TENANT,
        platform,
        attrs(),
      ),
    ).toEqual({ value: false, source: 'tenant' });
    expect(
      resolveSetting(
        beta,
        [],
        user,
        [],
        TENANT,
        platform,
        attrs({ tenant: { slug: 'zed', operator: false } }),
      ),
    ).toEqual({ value: false, source: 'platform' });
  });

  it('ignores rules on a setting that is not a flag', () => {
    const plain = {
      key: 'a.b',
      label: 'x',
      schema: z.boolean(),
      default: false,
    };
    expect(
      resolveSetting(
        plain,
        [{ ...row([rule('principalKind', { kinds: ['user'] })]), key: 'a.b' }],
        user,
        [],
        TENANT,
        undefined,
        attrs(),
      ),
    ).toEqual({ value: false, source: 'default' });
  });
});
