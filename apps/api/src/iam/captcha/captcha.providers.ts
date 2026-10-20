import type { HttpClient } from '@nestjs/http-client';
import type { CoreEnv } from '../../core/config/core.env.js';
import type { IamEnv } from '../iam.env.js';
import type { CaptchaVerifier } from './captcha-verifier.js';
import { StubCaptchaVerifier } from './stub.verifier.js';
import { TurnstileVerifier } from './turnstile.verifier.js';

/** The part of the environment the choice of verifier reads. */
export type CaptchaEnv = Pick<
  IamEnv & CoreEnv,
  | 'NODE_ENV'
  | 'APP_ENV'
  | 'CAPTCHA_MODE'
  | 'CAPTCHA_PROVIDER'
  | 'CAPTCHA_VERIFY_URL'
  | 'TURNSTILE_SITE_KEY'
  | 'TURNSTILE_SECRET_KEY'
>;

/** Cloudflare's endpoint: CAPTCHA_VERIFY_URL's default (iam.env.ts). */
export const TURNSTILE_VERIFY_URL =
  'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/** The siteverify URL split for @nestjs/http-client: its origin, and the path to post to. */
export function verifyEndpoint(url: string | undefined) {
  const parsed = new URL(url ?? TURNSTILE_VERIFY_URL);
  return { baseUrl: parsed.origin, path: parsed.pathname };
}

/** An APP_ENV that names production (`production`, `prod`, `prod-eu`): the stub is refused there too. */
const productionLike = (appEnv: string | undefined) =>
  /^prod/i.test(appEnv ?? '');

/** The APP_ENV of the load test's stack (compose.loadtest.yaml): the one name that lets a production build run the stub. */
export const LOADTEST_APP_ENV = 'loadtest';

/**
 * The verifier CAPTCHA_PROVIDER names, checked at startup like any other
 * setting: Turnstile wants both keys once the mode is on, and the stub is
 * never accepted where production might be: NODE_ENV=production (except
 * with APP_ENV=loadtest, the load test's stack, which runs the production
 * image to measure the bot check's cost), an APP_ENV that names production,
 * or a Turnstile secret in place (a stub next to a real key is a switch
 * someone forgot). A test runs it on staging (APP_ENV=staging, no secret) or
 * with NODE_ENV=test. `http` is the client registered on CAPTCHA_VERIFY_URL's
 * origin (TURNSTILE_HTTP).
 */
export function createCaptchaVerifier(
  env: CaptchaEnv,
  http: HttpClient,
): CaptchaVerifier {
  if (env.CAPTCHA_PROVIDER === 'stub') {
    const refused =
      env.NODE_ENV === 'production' && env.APP_ENV !== LOADTEST_APP_ENV
        ? `NODE_ENV=production without APP_ENV=${LOADTEST_APP_ENV}`
        : productionLike(env.APP_ENV)
          ? `APP_ENV=${env.APP_ENV}`
          : env.TURNSTILE_SECRET_KEY
            ? 'TURNSTILE_SECRET_KEY is set'
            : undefined;
    if (refused) {
      throw new Error(
        `CAPTCHA_PROVIDER=stub is refused (${refused}): use turnstile, or CAPTCHA_MODE=off`,
      );
    }
    return new StubCaptchaVerifier();
  }
  const secretKey = env.TURNSTILE_SECRET_KEY;
  const siteKey = env.TURNSTILE_SITE_KEY;
  if (env.CAPTCHA_MODE !== 'off' && !(secretKey && siteKey)) {
    throw new Error(
      `CAPTCHA_MODE=${env.CAPTCHA_MODE} needs TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY (or TURNSTILE_SECRET_KEY_FILE)`,
    );
  }
  return new TurnstileVerifier(
    http,
    verifyEndpoint(env.CAPTCHA_VERIFY_URL).path,
    secretKey ?? '',
    siteKey ?? '',
  );
}
