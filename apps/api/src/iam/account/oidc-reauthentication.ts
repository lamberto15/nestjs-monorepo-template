import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS } from '../../core/redis/redis.js';

/** A step-up through a provider under way: who started it, when, and where the browser goes back to. */
export interface ProviderReauthentication {
  userId: string;
  /** Epoch milliseconds: the ID token's `auth_time` must not be older (less the tolerance). */
  startedAt: number;
  redirectTo?: string;
  /** The tenant the re-authenticated session acted in: the new one keeps it (while still a member). */
  tenantId?: string | null;
}

/** As long as the package keeps the login's transaction (`oidc.transactionTtl`, 10 minutes). */
const TTL_MS = 10 * 60_000;
/** The clocks of the IdP and this app may differ: as the package's ID token checks (`clockTolerance`, 30 s). */
export const AUTH_TIME_TOLERANCE_MS = 30_000;

/**
 * Why a step-up through a provider was refused: the provider signed in
 * another account (or one not connected to this user); its `auth_time`
 * says it didn't ask the user again (it ignored `prompt=login`), or an
 * OpenID Connect provider sent none; or the browser came back from a
 * step-up this app no longer knows (`expired`: never a plain sign-in).
 */
export class ReauthenticationRefused extends Error {
  constructor(
    readonly reason: 'account' | 'stale' | 'expired',
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
 * started: `auth_time` no older than `startedAt`, less the clock
 * tolerance. An OpenID Connect provider (`requireAuthTime`) issues an ID
 * token, and `max_age` makes the claim required in it: without one, the
 * login is refused. A plain OAuth 2.0 provider (GitHub) has no ID token,
 * so nothing says otherwise: accepted, the weaker guarantee docs/auth.md
 * describes.
 */
export function isFreshAuthentication(
  authTime: Date | undefined,
  startedAt: number,
  { requireAuthTime }: { requireAuthTime: boolean },
) {
  if (authTime === undefined) {
    return !requireAuthTime;
  }
  return authTime.getTime() >= startedAt - AUTH_TIME_TOLERANCE_MS;
}

/**
 * The cookie that tells the callback this browser started a step-up, and
 * which (its `state`): a step-up callback whose marker is gone is refused,
 * never finished as a plain sign-in. `__Host-` when Secure (as the
 * package's `__Host-oidc_tx`), SameSite=Lax to survive the provider's
 * redirect back, as long as the login.
 */
export function reauthenticationCookie(secure: boolean) {
  const name = secure ? '__Host-oidc_reauth' : 'oidc_reauth';
  const attributes = (maxAge: number) =>
    `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
  return {
    name,
    set: (state: string) =>
      `${name}=${encodeURIComponent(state)}; ${attributes(TTL_MS / 1000)}`,
    clear: () => `${name}=; ${attributes(0)}`,
    /** The state the request's cookie names, if any. */
    read(header: string | undefined) {
      for (const part of (header ?? '').split(';')) {
        const [key, ...value] = part.trim().split('=');
        if (key === name) {
          try {
            return decodeURIComponent(value.join('='));
          } catch {
            return undefined;
          }
        }
      }
      return undefined;
    },
  };
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

  /**
   * The step-up a callback's `state` names; undefined for a plain sign-in.
   * Read, not taken: a callback that fails the package's checks (no
   * transaction cookie: someone else's request with a state they learnt)
   * must leave it for the browser that started it. `forget()` once the
   * callback was judged.
   */
  async peek(state: unknown): Promise<ProviderReauthentication | undefined> {
    if (!validState(state)) {
      return undefined;
    }
    const value = await this.redis.get(key(state));
    return value ? (JSON.parse(value) as ProviderReauthentication) : undefined;
  }

  async forget(state: unknown) {
    if (validState(state)) {
      await this.redis.del(key(state));
    }
  }
}

function validState(state: unknown): state is string {
  return typeof state === 'string' && state.length > 0 && state.length <= 256;
}

const key = (state: string) => `oidc:reauthentication:${state}`;
