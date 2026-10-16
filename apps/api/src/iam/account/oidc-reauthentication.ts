import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS } from '../../core/redis/redis.js';

/** A step-up through a provider under way: who started it, when, and where the browser goes back to. */
export interface ProviderReauthentication {
  userId: string;
  /** Epoch milliseconds: the ID token's `auth_time` must not be older (less the tolerance). */
  startedAt: number;
  redirectTo?: string;
}

/** As long as the package keeps the login's transaction (`oidc.transactionTtl`, 10 minutes). */
const TTL_MS = 10 * 60_000;
/** The clocks of the IdP and this app may differ: as the package's ID token checks (`clockTolerance`, 30 s). */
export const AUTH_TIME_TOLERANCE_MS = 30_000;

/**
 * Why a step-up through a provider was refused: the provider signed in
 * another account (or one not connected to this user), or its `auth_time`
 * says it didn't ask the user again (it ignored `prompt=login`).
 */
export class ReauthenticationRefused extends Error {
  constructor(
    readonly reason: 'account' | 'stale',
    readonly redirectTo?: string,
  ) {
    super(`provider re-authentication refused: ${reason}`);
  }
}

/**
 * The authorization URL of a step-up: the provider's own, with
 * `prompt=login` (OpenID Connect: ask the user again, even with a session
 * at the provider) and `max_age=0` (the same, for providers that honour it
 * rather than `prompt`; it also makes `auth_time` required in the ID
 * token). Hints that travel through the browser: the callback checks
 * `auth_time` itself (`isFreshAuthentication()`).
 *
 * Custom: @nestjs/authentication's `OidcService.start()` takes no
 * per-request parameters (its `authorizationParams` are per provider, so
 * every sign-in would ask), so the URL it answers is extended here; the
 * PKCE, `state` and `nonce` it carries are untouched.
 */
export function reauthenticationUrl(authorizationUrl: string) {
  const url = new URL(authorizationUrl);
  url.searchParams.set('prompt', 'login');
  url.searchParams.set('max_age', '0');
  return url;
}

/**
 * Whether the user authenticated at the provider after the step-up
 * started: `auth_time` (when the ID token has one) no older than
 * `startedAt`, less the clock tolerance. Without it (GitHub: OAuth 2.0, no
 * ID token), nothing says otherwise: accepted, the weaker guarantee
 * docs/auth.md describes.
 */
export function isFreshAuthentication(
  authTime: Date | undefined,
  startedAt: number,
) {
  return (
    authTime === undefined ||
    authTime.getTime() >= startedAt - AUTH_TIME_TOLERANCE_MS
  );
}

/**
 * The step-ups through a provider under way, by the login's `state` (the
 * package keeps its own transaction under it; this one says the login is a
 * re-authentication, and of whom), in Redis so the callback may reach any
 * replica. Taken once, by the callback.
 */
@Injectable()
export class ProviderReauthentications {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async remember(state: string, reauthentication: ProviderReauthentication) {
    await this.redis.set(
      key(state),
      JSON.stringify(reauthentication),
      'PX',
      TTL_MS,
    );
  }

  /** The step-up a callback's `state` finishes, once; undefined for a plain sign-in. */
  async take(state: unknown): Promise<ProviderReauthentication | undefined> {
    if (typeof state !== 'string' || state.length === 0 || state.length > 256) {
      return undefined;
    }
    const value = await this.redis.getdel(key(state));
    return value ? (JSON.parse(value) as ProviderReauthentication) : undefined;
  }
}

const key = (state: string) => `oidc:reauthentication:${state}`;
