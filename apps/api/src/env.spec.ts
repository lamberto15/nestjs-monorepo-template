import { envSchema } from './env.js';

// The least an environment needs to parse (DATABASE_URL is required).
const base = { DATABASE_URL: 'postgres://app_runtime@localhost:5432/app' };
const issues = (env: Record<string, string>) => {
  const result = envSchema.safeParse({ ...base, ...env });
  return result.success
    ? []
    : result.error.issues.map((issue) => issue.path.join('.'));
};

describe('RATE_LIMIT_MULTIPLIER in production', () => {
  it('refuses raised limits under NODE_ENV=production', () => {
    expect(
      issues({ NODE_ENV: 'production', RATE_LIMIT_MULTIPLIER: '1000' }),
    ).toEqual(['RATE_LIMIT_MULTIPLIER']);
    expect(
      issues({
        NODE_ENV: 'production',
        APP_ENV: 'staging',
        RATE_LIMIT_MULTIPLIER: '2',
      }),
    ).toEqual(['RATE_LIMIT_MULTIPLIER']);
  });

  it("allows them on the load test's stack (APP_ENV=loadtest)", () => {
    expect(
      issues({
        NODE_ENV: 'production',
        APP_ENV: 'loadtest',
        RATE_LIMIT_MULTIPLIER: '1000',
      }),
    ).toEqual([]);
  });

  it('allows them outside production, and 1 everywhere', () => {
    expect(issues({ NODE_ENV: 'test', RATE_LIMIT_MULTIPLIER: '2' })).toEqual(
      [],
    );
    expect(issues({ NODE_ENV: 'production' })).toEqual([]);
  });
});
