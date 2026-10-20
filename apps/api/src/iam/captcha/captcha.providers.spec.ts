import { randomBytes } from 'node:crypto';
import { HttpClient } from '@nestjs/http-client';
import {
  type CaptchaEnv,
  createCaptchaVerifier,
  TURNSTILE_VERIFY_URL,
  verifyEndpoint,
} from './captcha.providers.js';
import { StubCaptchaVerifier } from './stub.verifier.js';
import { TurnstileVerifier } from './turnstile.verifier.js';

const http = new HttpClient({ baseUrl: 'https://challenges.example' });
// Made at runtime (a local hook refuses key-like literals).
const keys = () => ({
  TURNSTILE_SITE_KEY: `1x${randomBytes(11).toString('hex')}`,
  TURNSTILE_SECRET_KEY: `1x${randomBytes(16).toString('hex')}`,
});

/** The production environment of compose.prod.yaml, with the keys set. */
const production = (overrides: Partial<CaptchaEnv> = {}): CaptchaEnv => ({
  NODE_ENV: 'production',
  CAPTCHA_MODE: 'always',
  CAPTCHA_PROVIDER: 'turnstile',
  CAPTCHA_VERIFY_URL: TURNSTILE_VERIFY_URL,
  ...keys(),
  ...overrides,
});

describe('createCaptchaVerifier', () => {
  it('resolves the real Turnstile verifier in production, never the stub', () => {
    const verifier = createCaptchaVerifier(production(), http);
    expect(verifier).toBeInstanceOf(TurnstileVerifier);
    expect(verifier.provider).toBe('turnstile');
    expect(verifier).not.toBeInstanceOf(StubCaptchaVerifier);
  });

  it('refuses the stub in production, whatever the mode', () => {
    for (const mode of ['off', 'always', 'after-failures'] as const) {
      expect(() =>
        createCaptchaVerifier(
          production({ CAPTCHA_PROVIDER: 'stub', CAPTCHA_MODE: mode }),
          http,
        ),
      ).toThrow(
        /CAPTCHA_PROVIDER=stub is refused \(NODE_ENV=production without APP_ENV=loadtest\)/,
      );
    }
  });

  /** A load test's or a test's environment: the stub, no Turnstile secret. */
  const stubbed = (overrides: Partial<CaptchaEnv> = {}): CaptchaEnv =>
    production({
      NODE_ENV: 'test',
      CAPTCHA_PROVIDER: 'stub',
      TURNSTILE_SECRET_KEY: undefined,
      ...overrides,
    });

  it('gives the stub to tests and load tests outside production (staging too)', () => {
    for (const env of [
      { NODE_ENV: 'test' },
      { NODE_ENV: 'development' },
      { NODE_ENV: 'test', APP_ENV: 'staging' },
      { NODE_ENV: 'test', APP_ENV: 'preview-42' },
    ] as const) {
      const verifier = createCaptchaVerifier(stubbed(env), http);
      expect(verifier).toBeInstanceOf(StubCaptchaVerifier);
      expect(verifier.siteKey).toBeNull();
    }
  });

  it('refuses the stub where production might be: APP_ENV naming it, or a Turnstile secret in place', () => {
    for (const [env, reason] of [
      [{ APP_ENV: 'production' }, /APP_ENV=production/],
      [{ APP_ENV: 'prod-eu' }, /APP_ENV=prod-eu/],
      [
        { TURNSTILE_SECRET_KEY: keys().TURNSTILE_SECRET_KEY },
        /TURNSTILE_SECRET_KEY is set/,
      ],
    ] as const) {
      expect(() => createCaptchaVerifier(stubbed(env), http)).toThrow(reason);
    }
  });

  it('refuses the stub in production unless the stack is the load test (APP_ENV=loadtest)', () => {
    // Anything but the exact name: unset, a look-alike, a production name.
    for (const appEnv of [
      undefined,
      'staging',
      'loadtest-eu',
      'LOADTEST',
      'production',
      'prod-loadtest',
    ]) {
      expect(() =>
        createCaptchaVerifier(
          production({
            CAPTCHA_PROVIDER: 'stub',
            TURNSTILE_SECRET_KEY: undefined,
            APP_ENV: appEnv,
          }),
          http,
        ),
      ).toThrow(/CAPTCHA_PROVIDER=stub is refused/);
    }
    // The load test's stack: the production image, the stub, no secret.
    const verifier = createCaptchaVerifier(
      production({
        CAPTCHA_PROVIDER: 'stub',
        TURNSTILE_SECRET_KEY: undefined,
        APP_ENV: 'loadtest',
      }),
      http,
    );
    expect(verifier).toBeInstanceOf(StubCaptchaVerifier);
    // A real secret next to the stub is refused there too.
    expect(() =>
      createCaptchaVerifier(
        production({ CAPTCHA_PROVIDER: 'stub', APP_ENV: 'loadtest' }),
        http,
      ),
    ).toThrow(/TURNSTILE_SECRET_KEY is set/);
  });

  it('wants both Turnstile keys once the mode is on, and names them', () => {
    for (const missing of [
      'TURNSTILE_SITE_KEY',
      'TURNSTILE_SECRET_KEY',
    ] as const) {
      expect(() =>
        createCaptchaVerifier(production({ [missing]: undefined }), http),
      ).toThrow(/TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY/);
    }
  });

  it('starts without keys while the mode is off (existing deployments)', () => {
    const verifier = createCaptchaVerifier(
      production({
        CAPTCHA_MODE: 'off',
        TURNSTILE_SITE_KEY: undefined,
        TURNSTILE_SECRET_KEY: undefined,
      }),
      http,
    );
    expect(verifier).toBeInstanceOf(TurnstileVerifier);
  });

  it('exposes the site key, never the secret', () => {
    const env = production();
    const verifier = createCaptchaVerifier(env, http);
    expect(verifier.siteKey).toBe(env.TURNSTILE_SITE_KEY);
    expect(JSON.stringify(verifier)).not.toContain(env.TURNSTILE_SECRET_KEY);
  });
});

describe('verifyEndpoint', () => {
  it("splits Cloudflare's URL into the client's origin and the path to post to", () => {
    expect(verifyEndpoint(TURNSTILE_VERIFY_URL)).toEqual({
      baseUrl: 'https://challenges.cloudflare.com',
      path: '/turnstile/v0/siteverify',
    });
    expect(verifyEndpoint('http://127.0.0.1:4321/siteverify')).toEqual({
      baseUrl: 'http://127.0.0.1:4321',
      path: '/siteverify',
    });
    expect(verifyEndpoint(undefined).baseUrl).toBe(
      'https://challenges.cloudflare.com',
    );
  });
});
