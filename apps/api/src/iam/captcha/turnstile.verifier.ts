import type { HttpClient } from '@nestjs/http-client';
import {
  CaptchaUnavailableError,
  type CaptchaVerdict,
  type CaptchaVerification,
  type CaptchaVerifier,
} from './captcha-verifier.js';

/** The @nestjs/http-client client of the siteverify endpoint (IamModule registers it). */
export const TURNSTILE_HTTP = 'turnstile';

/** What siteverify answers (Cloudflare's documented shape). */
export interface SiteverifyResponse {
  success: boolean;
  /** ISO 8601: when the challenge was solved. */
  challenge_ts?: string;
  /** The host the widget ran on, without a port. */
  hostname?: string;
  'error-codes'?: string[];
  /** The widget's `data-action`, when it set one. */
  action?: string;
  cdata?: string;
}

/**
 * Cloudflare Turnstile: `POST …/siteverify { secret, response, remoteip,
 * idempotency_key }`, a JSON answer with `success`, `hostname`, `action` and
 * `error-codes`. A token is valid for 300 s and for one verification; the
 * endpoint answers `timeout-or-duplicate` for one it saw before.
 *
 * Custom code: no @nestjs package speaks to a challenge provider; the call
 * itself goes through @nestjs/http-client, the timeout and circuit breaker
 * around it through @nestjs/resilience (CaptchaService).
 */
export class TurnstileVerifier implements CaptchaVerifier {
  readonly provider = 'turnstile';
  /** A JS private field: never serialized or logged with the instance. */
  readonly #secretKey: string;

  constructor(
    private readonly http: HttpClient,
    /** The path of the endpoint on the client's base URL. */
    private readonly path: string,
    secretKey: string,
    readonly siteKey: string,
  ) {
    this.#secretKey = secretKey;
  }

  async verify(input: CaptchaVerification): Promise<CaptchaVerdict> {
    let answer: SiteverifyResponse;
    try {
      const response = await this.http.post<SiteverifyResponse>(this.path, {
        // No idempotency_key: there is one attempt (the policy never
        // retries), and a second verification of a token is a replay here.
        json: {
          secret: this.#secretKey,
          response: input.token,
          remoteip: input.ip,
        },
        responseType: 'json',
        signal: input.signal,
      });
      answer = response.data;
    } catch (error) {
      // A 4xx from siteverify is Cloudflare refusing our request (a bad
      // secret, a malformed body), never the user's token: still an outage
      // from the user's point of view, and logged as such.
      throw new CaptchaUnavailableError(describe(error));
    }
    if (typeof answer?.success !== 'boolean') {
      throw new CaptchaUnavailableError('malformed answer');
    }
    return judge(answer, input);
  }
}

/**
 * Error codes that say the *request* failed, not the token: our secret
 * (rotated wrongly, missing), a malformed request, Cloudflare's own error.
 * They arrive as a 200 with `success: false`; judging them as an invalid
 * token would lock every user out with a 403 and no alert, so they are an
 * outage (the breaker, the metric, CAPTCHA_ON_ERROR).
 */
const PROVIDER_SIDE_CODES = new Set([
  'invalid-input-secret',
  'missing-input-secret',
  'bad-request',
  'internal-error',
]);

/**
 * The verdict for a siteverify answer: refused when the provider says so,
 * when the widget ran on another host, or when it was rendered for another
 * action (or none: a token minted on the sign-in page can't be spent on
 * sign-up, and the widget must set `data-action`). A `timeout-or-duplicate`
 * is the provider's own replay refusal. Throws for a provider-side failure.
 */
export function judge(
  answer: SiteverifyResponse,
  input: Pick<CaptchaVerification, 'action' | 'hostnames'>,
): CaptchaVerdict {
  if (!answer.success) {
    const codes = answer['error-codes'] ?? [];
    const providerSide = codes.find((code) => PROVIDER_SIDE_CODES.has(code));
    if (providerSide) {
      throw new CaptchaUnavailableError(`siteverify: ${providerSide}`);
    }
    return {
      ok: false,
      reason: codes.includes('timeout-or-duplicate') ? 'duplicate' : 'invalid',
    };
  }
  if (
    typeof answer.hostname === 'string' &&
    !input.hostnames.includes(answer.hostname.toLowerCase())
  ) {
    return { ok: false, reason: 'hostname' };
  }
  if (answer.action !== input.action) {
    return { ok: false, reason: 'action' };
  }
  return { ok: true };
}

/** An error's kind and status, for the log: never the secret, the URL or a body. */
function describe(error: unknown) {
  if (!(error instanceof Error)) {
    return 'unknown error';
  }
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' ? `${error.name} ${status}` : error.name;
}
