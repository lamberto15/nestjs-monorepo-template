/** What a route hands the verifier with the token. */
export interface CaptchaVerification {
  /** The `X-Captcha-Token` header: what the widget produced. */
  token: string;
  /** The caller's address, for the provider's own checks. */
  ip: string;
  /** The route's action (`sign-in`, `sign-up`, …): the widget's `data-action`. */
  action: string;
  /** The host names the widget may run on (no port). */
  hostnames: readonly string[];
  /** Aborted when the attempt times out: pass it on to the HTTP call. */
  signal: AbortSignal;
}

/** Why a token was refused. `duplicate`: the provider saw it before (a replay). */
export type CaptchaRejection = 'invalid' | 'duplicate' | 'hostname' | 'action';

export type CaptchaVerdict =
  { ok: true } | { ok: false; reason: CaptchaRejection };

/**
 * One challenge provider (Cloudflare Turnstile today; hCaptcha or reCAPTCHA
 * would be another class with the same shape). `verify()` answers for a
 * token the provider could judge, and throws when it couldn't be asked
 * (network, timeout, a 5xx): the policy around it (CaptchaService) decides
 * what an outage means.
 */
export interface CaptchaVerifier {
  /** `turnstile`, `stub`…: what GET /auth/methods tells the frontend. */
  readonly provider: string;
  /** The public key the widget is rendered with, when the provider has one. */
  readonly siteKey: string | null;
  verify(input: CaptchaVerification): Promise<CaptchaVerdict>;
}

/** The injection token of the configured verifier (CAPTCHA_PROVIDER). */
export const CAPTCHA_VERIFIER = Symbol('CAPTCHA_VERIFIER');

/** The provider couldn't be asked: the request's fate follows CAPTCHA_ON_ERROR. */
export class CaptchaUnavailableError extends Error {
  constructor(reason: string) {
    super(`captcha provider unavailable: ${reason}`);
    this.name = 'CaptchaUnavailableError';
  }
}
