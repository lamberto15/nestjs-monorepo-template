import { envSchema } from './env.js';

// The least an environment needs to parse (DATABASE_URL is required).
const base = { DATABASE_URL: 'postgres://app_runtime@localhost:5432/app' };
// Production as Compose runs it: the API on its https host (the passkeys'
// relying party is refused on localhost there, below).
const production = {
  NODE_ENV: 'production',
  APP_URL: 'https://api.example.com',
};
const issues = (env: Record<string, string>) => {
  const result = envSchema.safeParse({ ...base, ...env });
  return result.success
    ? []
    : result.error.issues.map((issue) => issue.path.join('.'));
};

describe('RATE_LIMIT_MULTIPLIER in production', () => {
  it('refuses raised limits under NODE_ENV=production', () => {
    expect(issues({ ...production, RATE_LIMIT_MULTIPLIER: '1000' })).toEqual([
      'RATE_LIMIT_MULTIPLIER',
    ]);
    expect(
      issues({
        ...production,
        APP_ENV: 'staging',
        RATE_LIMIT_MULTIPLIER: '2',
      }),
    ).toEqual(['RATE_LIMIT_MULTIPLIER']);
  });

  it("allows them on the load test's stack (APP_ENV=loadtest)", () => {
    expect(
      issues({
        ...production,
        APP_ENV: 'loadtest',
        RATE_LIMIT_MULTIPLIER: '1000',
      }),
    ).toEqual([]);
  });

  it('allows them outside production, and 1 everywhere', () => {
    expect(issues({ NODE_ENV: 'test', RATE_LIMIT_MULTIPLIER: '2' })).toEqual(
      [],
    );
    expect(issues(production)).toEqual([]);
  });
});

describe('the passkeys relying party', () => {
  it('refuses localhost and plain http in production, naming the variables', () => {
    expect(issues({ NODE_ENV: 'production' }).sort()).toEqual([
      'PASSKEY_ORIGINS',
      'PASSKEY_RP_ID',
    ]);
    expect(issues({ NODE_ENV: 'production', PASSKEYS: 'off' })).toEqual([]);
    expect(issues({ NODE_ENV: 'development' })).toEqual([]);
  });

  it('refuses origins outside the RP ID, and malformed entries', () => {
    expect(
      issues({ ...production, PASSKEY_ORIGINS: 'https://example.org' }),
    ).toEqual(['PASSKEY_RP_ID']);
    expect(
      new Set(issues({ ...production, PASSKEY_RP_ID: 'https://example.com' })),
    ).toEqual(new Set(['PASSKEY_RP_ID']));
    expect(
      issues({ ...production, PASSKEY_ANDROID_APPS: 'com.example.app:AB' }),
    ).toEqual(['PASSKEY_ANDROID_APPS']);
    expect(
      issues({ ...production, PASSKEY_APPLE_APPS: 'com.example.app' }),
    ).toEqual(['PASSKEY_APPLE_APPS']);
  });
});
