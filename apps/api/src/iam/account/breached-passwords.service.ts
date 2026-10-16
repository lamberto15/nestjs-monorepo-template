import { createHash } from 'node:crypto';
import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpClient, InjectHttpClient } from '@nestjs/http-client';
import { t } from '@nestjs/i18n';
import type { IamEnv } from '../iam.env.js';

/** The @nestjs/http-client client of the Pwned Passwords range API (IamModule registers it). */
export const PWNED_PASSWORDS = 'pwned-passwords';

/**
 * The k-anonymity split of a password: the upper-case hex SHA-1, its first
 * 5 characters (the only part sent) and the other 35 (compared here).
 */
export function hashRange(password: string) {
  const hash = createHash('sha1')
    .update(password, 'utf8')
    .digest('hex')
    .toUpperCase();
  return { prefix: hash.slice(0, 5), suffix: hash.slice(5) };
}

/**
 * How often `suffix` was seen, from a range response (`SUFFIX:COUNT` per
 * line). Padding lines (`Add-Padding: true`) have the count 0, so they never
 * match as breached.
 */
export function countInRange(body: string, suffix: string) {
  const wanted = suffix.toUpperCase();
  for (const line of body.split('\n')) {
    const [candidate, count] = line.trim().split(':');
    if (candidate?.toUpperCase() === wanted) {
      const seen = Number.parseInt(count ?? '', 10);
      return Number.isFinite(seen) && seen > 0 ? seen : 0;
    }
  }
  return 0;
}

/**
 * New passwords against the passwords of known data breaches (NIST SP
 * 800-63B: refuse values from breach corpora), through Have I Been Pwned's
 * Pwned Passwords range API with k-anonymity: only the first 5 characters
 * of the password's SHA-1 are sent (with `Add-Padding: true`, so the
 * response's size says nothing either), the suffixes are compared here.
 * The password and its full hash are never sent or logged.
 *
 * Custom code: neither @nestjs/authentication nor any other @nestjs package
 * has a breached-password check; the call itself goes through
 * @nestjs/http-client. Stateless, so any number of instances can run it.
 */
@Injectable()
export class BreachedPasswordsService {
  private readonly logger = new Logger('BreachedPasswords');

  constructor(
    @InjectHttpClient(PWNED_PASSWORDS) private readonly http: HttpClient,
    private readonly config: ConfigService<IamEnv, true>,
  ) {}

  /** Whether the check runs (PASSWORD_BREACH_CHECK). */
  get enabled() {
    return this.config.get('PASSWORD_BREACH_CHECK', { infer: true });
  }

  /**
   * How many times the password appears in the breaches: 0 when never;
   * `undefined` when the check is off or the API couldn't be reached
   * (logged as a warning, without the password or its hash).
   */
  async timesSeen(password: string): Promise<number | undefined> {
    if (!this.enabled) {
      return undefined;
    }
    const { prefix, suffix } = hashRange(password);
    try {
      const response = await this.http.get('/range/:prefix', {
        params: { prefix },
        headers: { 'add-padding': 'true' },
        responseType: 'text',
      });
      return countInRange(response.data, suffix);
    } catch (error) {
      // The error's message names the URL; the reason is enough.
      this.logger.warn(
        `Pwned Passwords unreachable (${describe(error)}): the password was not checked`,
      );
      return undefined;
    }
  }

  /**
   * Whether the password is in the breaches at least
   * PASSWORD_BREACH_MIN_COUNT times; `undefined` when unknown (check off,
   * API unreachable).
   */
  async isBreached(password: string): Promise<boolean | undefined> {
    const seen = await this.timesSeen(password);
    return seen === undefined
      ? undefined
      : seen >= this.config.get('PASSWORD_BREACH_MIN_COUNT', { infer: true });
  }

  /**
   * A 400 `password_breached` (on the field `path`) when the password is
   * in the breaches at least PASSWORD_BREACH_MIN_COUNT times. When the API
   * can't be reached: allowed (PASSWORD_BREACH_ON_ERROR=allow, the default),
   * or a 503 `password_check_unavailable` (`reject`).
   */
  async assertNotBreached(password: string, path: string) {
    if (!this.enabled) {
      return;
    }
    const breached = await this.isBreached(password);
    if (breached === undefined) {
      if (
        this.config.get('PASSWORD_BREACH_ON_ERROR', { infer: true }) ===
        'reject'
      ) {
        throw new ServiceUnavailableException({
          code: 'password_check_unavailable',
          message: t('auth.passwordCheckUnavailable'),
          retryAfter: 60,
        });
      }
      return;
    }
    if (breached) {
      const message = t('auth.passwordBreached');
      // Nothing else: not how often it was seen, nor where.
      throw new BadRequestException({
        code: 'password_breached',
        message,
        errors: [{ path, message }],
      });
    }
  }
}

/** An error's kind and status, for the log: never its URL or body. */
function describe(error: unknown) {
  if (!(error instanceof Error)) {
    return 'unknown error';
  }
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' ? `${error.name} ${status}` : error.name;
}
