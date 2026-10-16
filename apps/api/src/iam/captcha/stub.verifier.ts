import {
  CaptchaUnavailableError,
  type CaptchaVerdict,
  type CaptchaVerification,
  type CaptchaVerifier,
} from './captcha-verifier.js';

/**
 * The tokens the stub understands; anything else is `invalid`. Each may
 * carry a suffix (`stub:pass:<anything unique>`): the service refuses a
 * token it saw before (the replay set), so a load test sends a fresh one
 * per request.
 */
export const STUB_TOKENS = {
  /** Passes. */
  pass: 'stub:pass',
  /** Refused as invalid. */
  fail: 'stub:fail',
  /** Refused as already used (the provider's own replay answer). */
  spent: 'stub:spent',
  /** Passes, but reports another host: refused `hostname`. */
  elsewhere: 'stub:elsewhere',
  /** Passes, but was minted for another action: refused `action`. */
  otherAction: 'stub:other-action',
  /** The provider is down: throws. */
  down: 'stub:down',
  /** The provider hangs: never answers until the attempt's signal aborts (the timeout). */
  slow: 'stub:slow',
} as const;

/**
 * A verifier without a provider, for the e2e tests and the load tests
 * (CAPTCHA_PROVIDER=stub; refused in production, captcha.providers.ts).
 * It judges by the token's text (STUB_TOKENS), so a test or a load script
 * sends `X-Captcha-Token: stub:pass` and nothing leaves the process.
 */
export class StubCaptchaVerifier implements CaptchaVerifier {
  readonly provider = 'stub';
  readonly siteKey = null;

  async verify(input: CaptchaVerification): Promise<CaptchaVerdict> {
    const kind = input.token.split(':').slice(0, 2).join(':');
    switch (kind) {
      case STUB_TOKENS.pass:
        return { ok: true };
      case STUB_TOKENS.spent:
        return { ok: false, reason: 'duplicate' };
      case STUB_TOKENS.elsewhere:
        return { ok: false, reason: 'hostname' };
      case STUB_TOKENS.otherAction:
        return { ok: false, reason: 'action' };
      case STUB_TOKENS.down:
        throw new CaptchaUnavailableError('stub: down');
      case STUB_TOKENS.slow:
        return new Promise((_, reject) => {
          const abort = () =>
            reject(input.signal.reason ?? new Error('aborted'));
          if (input.signal.aborted) {
            abort();
          } else {
            input.signal.addEventListener('abort', abort, { once: true });
          }
        });
      default:
        return { ok: false, reason: 'invalid' };
    }
  }
}
