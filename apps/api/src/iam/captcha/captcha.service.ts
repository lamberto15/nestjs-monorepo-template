import { createHash } from 'node:crypto';
import {
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { t } from '@nestjs/i18n';
import { type ResiliencePolicy, ResilienceService } from '@nestjs/resilience';
import {
  InjectThrottlerStorage,
  type ThrottlerStorage,
} from '@nestjs/throttler';
import type { Redis } from 'ioredis';
import { Counter } from 'prom-client';
import { type CoreEnv, webUrl } from '../../core/config/core.env.js';
import { MetricsService } from '../../core/metrics/metrics.service.js';
import { REDIS } from '../../core/redis/redis.js';
import type { IamEnv } from '../iam.env.js';
import {
  CAPTCHA_VERIFIER,
  type CaptchaVerdict,
  type CaptchaVerifier,
} from './captcha-verifier.js';

/** The circuit breaker's name (`ResilienceService.circuitBreaker()`, the ops event stream). */
export const CAPTCHA_BREAKER = 'captcha';
/** How long a used token's hash is remembered: Turnstile tokens live 300 s. */
const USED_TOKEN_TTL_SECONDS = 300;
/** Longer than any provider's token: refused without asking. */
const MAX_TOKEN_LENGTH = 2048;
/** When the provider is down and the policy is fail-closed: come back in. */
const UNAVAILABLE_RETRY_AFTER_SECONDS = 30;

export type CaptchaOutcome = 'passed' | 'rejected' | 'replayed' | 'unavailable';
const OUTCOMES: CaptchaOutcome[] = [
  'passed',
  'rejected',
  'replayed',
  'unavailable',
];

/** What a guarded request is identified by: its address, and the account it names. */
export interface CaptchaRequest {
  ip: string;
  /** The body's `email`, when it has one. */
  email?: string | undefined;
  /** The route's action (`sign-in`, `sign-up`, …). */
  action: string;
}

/**
 * Counts the attempt now and gives the new count back: INCR, and the
 * window's expiry set once (EXPIRE NX: a fixed window from the first
 * attempt). Atomic, so a parallel burst from one address, on any replica,
 * counts every request before any of them is judged.
 */
const COUNT_ATTEMPT = `
local count = redis.call('INCR', KEYS[1])
redis.call('EXPIRE', KEYS[1], ARGV[1], 'NX')
return count`;

/** Gives one reserved attempt back, never below zero (the key may have expired meanwhile). */
const RELEASE_ATTEMPT = `
local count = tonumber(redis.call('GET', KEYS[1]) or '0')
if count > 0 then return redis.call('DECR', KEYS[1]) end
return 0`;

/**
 * The bot-protection policy around the verifier (docs/auth.md, "Bot
 * protection"): when a token is required (CAPTCHA_MODE), the replay set,
 * the failure counters, the timeout and circuit breaker around the
 * provider (@nestjs/resilience), and what an outage means
 * (CAPTCHA_ON_ERROR). The guard (captcha.guard.ts) calls `check()` before
 * the handler and, on a route that counts failures, `release()` when the
 * answer was none.
 *
 * Counters live in Redis under the throttler's connection, keyed by a hash
 * of the address, or of the email and address (the same keys on every
 * guarded route), so they hold across instances and, for an address or an
 * email that has no account, look exactly like those of one that has: the
 * challenge never says whether an account exists. Each attempt is counted
 * atomically before it is judged (a burst can't slip under the limit); a
 * `failures` route reserves the attempt and gives it back on success. The
 * fail-open tier counts in the throttler's own storage (`ThrottlerStorage`,
 * the `captcha-degraded` throttler). The circuit breaker is per process:
 * each replica opens its own.
 *
 * Custom code: @nestjs/throttler limits requests, not failures, and knows
 * no challenge; @nestjs/authentication has no bot protection. The
 * verification itself is the verifier's; the policy is here.
 */
@Injectable()
export class CaptchaService {
  private readonly logger = new Logger('Captcha');
  private readonly policy: ResiliencePolicy;
  private readonly verifications: Counter<'outcome'>;

  constructor(
    @Inject(CAPTCHA_VERIFIER) private readonly verifier: CaptchaVerifier,
    @Inject(REDIS) private readonly redis: Redis,
    @InjectThrottlerStorage() private readonly throttles: ThrottlerStorage,
    private readonly resilience: ResilienceService,
    private readonly config: ConfigService<IamEnv & CoreEnv, true>,
    metrics: MetricsService,
  ) {
    // One attempt within the timeout (the user waits on it); the breaker
    // opens after half of the last calls failed (5 at least), so a provider
    // that is down costs nobody the timeout for 30 s at a time.
    this.policy = resilience.create(
      {
        retry: false,
        timeout: this.config.get('CAPTCHA_TIMEOUT_MS', { infer: true }),
        circuitBreaker: {
          name: CAPTCHA_BREAKER,
          failureRateThreshold: 50,
          minimumCalls: 5,
          slidingWindow: { type: 'count', size: 10 },
          openDuration: '30s',
        },
      },
      CAPTCHA_BREAKER,
    );
    this.verifications = new Counter({
      name: 'captcha_verifications_total',
      help: 'Challenge tokens checked, by outcome: passed, rejected (invalid, replayed by the provider, another host or action), replayed (seen here before), unavailable (the provider could not be asked).',
      labelNames: ['outcome'] as const,
      registers: [metrics.registry],
    });
    for (const outcome of OUTCOMES) {
      this.verifications.labels(outcome).inc(0);
    }
  }

  /** `off`, `always` or `after-failures` (CAPTCHA_MODE). */
  get mode() {
    return this.config.get('CAPTCHA_MODE', { infer: true });
  }

  /** What the sign-in page needs to render the widget (GET /auth/methods); null when off. */
  settings() {
    const mode = this.mode;
    if (mode === 'off') {
      return null;
    }
    return {
      provider: this.verifier.provider,
      siteKey: this.verifier.siteKey,
      mode,
    };
  }

  /**
   * Refuses the request unless it carries a valid token when one is
   * required. 403 `captcha_required` (no token), 403 `captcha_invalid`
   * (refused, with `reason`), 503 `captcha_unavailable` (the provider is
   * down and CAPTCHA_ON_ERROR=reject), 429 `rate_limited` (down, fail-open,
   * and this address has used its unverified requests).
   */
  async check(token: string | undefined, request: CaptchaRequest) {
    if (this.mode === 'off') {
      return;
    }
    const trackers = this.trackers(request);
    if (this.mode === 'after-failures' && !(await this.overLimit(trackers))) {
      return;
    }
    await this.verifyToken(token, request, trackers);
  }

  /**
   * `after-failures`, a `failures` route whose answer was no 4xx (a
   * sign-in that succeeded): the attempt `check()` reserved is given back.
   * A client that drops the connection keeps its reservation.
   */
  async release(request: Pick<CaptchaRequest, 'ip' | 'email'>) {
    if (this.mode !== 'after-failures') {
      return;
    }
    try {
      const pipeline = this.redis.pipeline();
      for (const tracker of this.trackers(request)) {
        pipeline.eval(RELEASE_ATTEMPT, 1, this.failuresKey(tracker));
      }
      await pipeline.exec();
    } catch (error) {
      this.logger.warn(`attempt not released: ${(error as Error).message}`);
    }
  }

  private async verifyToken(
    token: string | undefined,
    request: CaptchaRequest,
    trackers: string[],
  ) {
    if (!token) {
      // The widget can't mint a token while the provider is down: fail-open
      // lets the request through under the strict tier, fail-closed refuses it.
      if (this.providerDown) {
        return this.unavailable('circuit open, no token', trackers);
      }
      throw new ForbiddenException({
        code: 'captcha_required',
        message: t('auth.captchaRequired'),
        ...this.widget(request.action),
      });
    }
    if (token.length > MAX_TOKEN_LENGTH) {
      this.verifications.labels('rejected').inc();
      throw this.refused('invalid', request.action);
    }
    if (!(await this.firstUse(token))) {
      this.verifications.labels('replayed').inc();
      throw this.refused('duplicate', request.action);
    }
    let verdict: CaptchaVerdict;
    try {
      verdict = await this.policy.execute((attempt) =>
        this.verifier.verify({
          token,
          ip: request.ip,
          action: request.action,
          hostnames: this.hostnames(),
          signal: attempt.signal,
        }),
      );
    } catch (error) {
      // Never judged, so not spent: the client may present it again
      // (fail-closed says when, with Retry-After).
      await this.forget(token);
      return this.unavailable((error as Error).message, trackers);
    }
    if (!verdict.ok) {
      this.verifications.labels('rejected').inc();
      throw this.refused(verdict.reason, request.action);
    }
    this.verifications.labels('passed').inc();
  }

  /** Whether the breaker is open: the provider has been failing. */
  private get providerDown() {
    return this.resilience.circuitBreaker(CAPTCHA_BREAKER).state === 'open';
  }

  /**
   * Counts this attempt against the address, and against the email and
   * address, and says whether any of them is now past CAPTCHA_FAILURES: the
   * attempt after the N counted ones wants a token. Counted before the
   * request is judged, atomically, so a parallel burst can't all read a
   * count below the limit; a `failures` route gives the attempt back on
   * success (`release()`).
   */
  private async overLimit(trackers: string[]) {
    const ttl = this.windowSeconds();
    const pipeline = this.redis.pipeline();
    for (const tracker of trackers) {
      pipeline.eval(COUNT_ATTEMPT, 1, this.failuresKey(tracker), ttl);
    }
    const results = (await pipeline.exec()) ?? [];
    const limit = this.config.get('CAPTCHA_FAILURES', { infer: true });
    return results.some(([error, count]) => {
      if (error) {
        throw error;
      }
      return Number(count) > limit;
    });
  }

  /** Remembers the token's hash; false when it was seen before (a replay). */
  private async firstUse(token: string) {
    const set = await this.redis.set(
      this.usedKey(token),
      '1',
      'EX',
      USED_TOKEN_TTL_SECONDS,
      'NX',
    );
    return set === 'OK';
  }

  /** The token was never judged: it may be presented again. */
  private async forget(token: string) {
    try {
      await this.redis.del(this.usedKey(token));
    } catch (error) {
      this.logger.warn(`used token not forgotten: ${(error as Error).message}`);
    }
  }

  private usedKey(token: string) {
    return `captcha:used:${sha256(token)}`;
  }

  /** The provider couldn't be asked: refuse (fail-closed), or let through under the strict tier. */
  private async unavailable(reason: string, trackers: string[]) {
    this.verifications.labels('unavailable').inc();
    if (this.config.get('CAPTCHA_ON_ERROR', { infer: true }) === 'reject') {
      this.logger.warn(`provider unavailable (${reason}): request refused`);
      throw new ServiceUnavailableException({
        code: 'captcha_unavailable',
        message: t('auth.captchaUnavailable'),
        retryAfter: UNAVAILABLE_RETRY_AFTER_SECONDS,
      });
    }
    const ttl = this.windowSeconds() * 1000;
    const limit = this.config.get('CAPTCHA_DEGRADED_LIMIT', { infer: true });
    let retryAfter = 0;
    for (const tracker of trackers) {
      const record = await this.throttles.increment(
        `captcha-degraded:${sha256(tracker)}`,
        ttl,
        limit,
        ttl,
        'captcha-degraded',
      );
      if (record.isBlocked) {
        retryAfter = Math.max(
          retryAfter,
          Math.ceil(record.timeToBlockExpire / 1000),
        );
      }
    }
    if (retryAfter > 0) {
      this.logger.warn(
        `provider unavailable (${reason}): request refused, over the fail-open limit`,
      );
      throw new HttpException(
        {
          code: 'rate_limited',
          message: t('auth.captchaDegraded'),
          retryAfter,
        },
        429,
      );
    }
    this.logger.warn(
      `provider unavailable (${reason}): request let through unverified (fail-open)`,
    );
  }

  private refused(reason: string, action: string) {
    return new ForbiddenException({
      code: 'captcha_invalid',
      message: t('auth.captchaInvalid'),
      reason,
      ...this.widget(action),
    });
  }

  /** What the client needs to render the widget again. */
  private widget(action: string) {
    return {
      provider: this.verifier.provider,
      siteKey: this.verifier.siteKey,
      action,
    };
  }

  /**
   * The address, and the email (normalized as the throttler does) with the
   * address: the same keys on every guarded route, so a bot alternating the
   * browser's and the token sign-in trips the challenge on both.
   */
  private trackers({ ip, email }: Pick<CaptchaRequest, 'ip' | 'email'>) {
    const address = ip || 'unknown';
    const normalized = email?.trim().normalize('NFC').toLowerCase();
    return normalized ? [address, `${normalized}|${address}`] : [address];
  }

  private failuresKey(tracker: string) {
    return `captcha:failures:${sha256(tracker)}`;
  }

  private windowSeconds() {
    return (
      this.config.get('CAPTCHA_FAILURES_WINDOW_MINUTES', { infer: true }) * 60
    );
  }

  /** CAPTCHA_HOSTNAMES, else WEB_URL's host, lower-case. */
  private hostnames() {
    const configured = this.config.get('CAPTCHA_HOSTNAMES', { infer: true });
    const names =
      configured.length > 0
        ? configured
        : [new URL(webUrl(this.config) ?? 'http://localhost').hostname];
    return names.map((name) => name.toLowerCase());
  }
}

const sha256 = (value: string) =>
  createHash('sha256').update(value, 'utf8').digest('base64url');
