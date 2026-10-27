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

describe('worker concurrency variables', () => {
  const parsed = envSchema.parse({
    DATABASE_URL: 'postgres://app_runtime@localhost:5432/app',
  }) as Record<string, unknown>;

  it('default to the values that were hard-coded', () => {
    expect({
      mail: parsed.QUEUE_CONCURRENCY_MAIL,
      messaging: parsed.QUEUE_CONCURRENCY_MESSAGING,
      attachmentScan: parsed.QUEUE_CONCURRENCY_ATTACHMENT_SCAN,
      dataTransfers: parsed.QUEUE_CONCURRENCY_DATA_TRANSFERS,
      bulk: parsed.QUEUE_CONCURRENCY_BULK,
      documents: parsed.QUEUE_CONCURRENCY_DOCUMENTS,
      ai: parsed.QUEUE_CONCURRENCY_AI,
      mailEvents: parsed.QUEUE_CONCURRENCY_MAIL_EVENTS,
      sso: parsed.QUEUE_CONCURRENCY_SSO,
      retention: parsed.QUEUE_CONCURRENCY_RETENTION,
      reencryption: parsed.QUEUE_CONCURRENCY_REENCRYPTION,
      attachmentImages: parsed.QUEUE_CONCURRENCY_ATTACHMENT_IMAGES,
      relayBatch: parsed.OUTBOX_RELAY_BATCH_SIZE,
      relayConcurrency: parsed.OUTBOX_RELAY_CONCURRENCY,
      workflows: parsed.WORKFLOW_CONCURRENCY,
    }).toEqual({
      mail: 5,
      messaging: 5,
      attachmentScan: 4,
      dataTransfers: 2,
      bulk: 2,
      documents: 2,
      ai: 2,
      mailEvents: 2,
      sso: 2,
      retention: 1,
      reencryption: 1,
      attachmentImages: 1,
      relayBatch: 100,
      relayConcurrency: 10,
      workflows: 10,
    });
  });

  it('refuse zero and parse numbers from strings', () => {
    const base = { DATABASE_URL: 'postgres://app_runtime@localhost:5432/app' };
    expect(
      envSchema.safeParse({ ...base, QUEUE_CONCURRENCY_BULK: '0' }).success,
    ).toBe(false);
    expect(
      envSchema.parse({ ...base, QUEUE_CONCURRENCY_BULK: '1' }),
    ).toMatchObject({ QUEUE_CONCURRENCY_BULK: 1 });
  });
});
