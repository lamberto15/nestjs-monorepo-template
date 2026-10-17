import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import type { ProviderReauthentication } from '../account/oidc-reauthentication.js';
import {
  type AuthenticationMetadata,
  methodMetadata,
} from './authentication-method.js';

/** What the sign-in under way told the session's metadata so far. */
interface SignInState {
  /** The package's method string: `magic-link`, `oidc:google`. */
  method?: string;
  /** When the user proved who they are, when it wasn't now (an ID token's `auth_time`). */
  authenticatedAt?: Date;
  /** A step-up through a provider: the sign-in must be this user's, and fresh. */
  reauthenticating?: ProviderReauthentication;
  /** The tenant the new session acts in, when the sign-in names one (a step-up keeps its session's). */
  tenantId?: string;
}

const SIGN_IN = Symbol('sign-in');

/**
 * The sign-in under way, for the session it creates. The package's own
 * sign-ins (a magic link's `consume()`, the OIDC callback's `finish()`) call
 * `SignInService.signIn()` with a method but no metadata of ours, and
 * `session.metadata(request)` (IamModule) is the one hook that runs inside
 * them, synchronously, in the request's async context. So a route that signs
 * in that way runs the call in `run()`, which puts the method in a CLS
 * context (nestjs-cls, AsyncLocalStorage) that `signInMetadata()` reads from
 * inside the hook: the method and the time land in the session's row in the
 * same write as the rest, with no second update to wait for.
 *
 * Custom: the package's `signIn()` takes `metadata` only from its direct
 * caller, and its services don't pass one through.
 */
@Injectable()
export class SignInContext {
  constructor(private readonly cls: ClsService) {}

  /**
   * Runs `fn` as a sign-in by `method`: the session it creates records it.
   * `reauthenticating`: the sign-in is a step-up through a provider
   * (OidcAccounts checks it is that user's, and fresh).
   */
  run<T>(
    method: string,
    fn: () => Promise<T>,
    { reauthenticating }: { reauthenticating?: ProviderReauthentication } = {},
  ): Promise<T> {
    return this.cls.run({ ifNested: 'inherit' }, () => {
      this.cls.set(SIGN_IN, {
        method,
        ...(reauthenticating && { reauthenticating }),
      } satisfies SignInState);
      return fn();
    });
  }

  /**
   * The session the sign-in under way creates acts in this tenant (a
   * step-up keeps the tenant of the session it re-authenticates), instead
   * of the user's last chosen. Outside `run()` there is no sign-in to tell.
   */
  keepTenant(tenantId: string) {
    if (!this.cls.isActive()) {
      return;
    }
    const state = this.cls.get<SignInState | undefined>(SIGN_IN);
    this.cls.set(SIGN_IN, { ...state, tenantId });
  }

  /** The step-up through a provider the sign-in under way finishes, if it is one. */
  reauthenticating(): ProviderReauthentication | undefined {
    if (!this.cls.isActive()) {
      return undefined;
    }
    return this.cls.get<SignInState | undefined>(SIGN_IN)?.reauthenticating;
  }

  /**
   * The user proved who they are at `at`, not now: an OIDC provider's
   * `auth_time` (the provider may have signed them in from its own session
   * without asking again). Outside `run()` there is no sign-in to tell.
   */
  authenticatedAt(at: Date) {
    if (!this.cls.isActive()) {
      return;
    }
    const state = this.cls.get<SignInState | undefined>(SIGN_IN);
    this.cls.set(SIGN_IN, { ...state, authenticatedAt: at });
  }
}

/**
 * An OpenID Connect `auth_time` claim (epoch seconds) as a date, or
 * undefined when it isn't one a session can record: not a finite number, or
 * outside what `Date` holds (`toISOString()` would throw in the metadata
 * hook, and fail the sign-in).
 */
export function authTimeOf(claims: Record<string, unknown> | undefined) {
  const authTime = claims?.auth_time;
  if (typeof authTime !== 'number' || !Number.isFinite(authTime)) {
    return undefined;
  }
  const at = new Date(authTime * 1000);
  return Number.isNaN(at.getTime()) ? undefined : at;
}

/**
 * What the session's metadata records of the sign-in under way: its method
 * (when `run()` named one) and `authenticatedAt`, the sign-in's own time
 * when it told one, else now. Safe outside any CLS context.
 */
export function signInMetadata(
  cls: ClsService,
): AuthenticationMetadata & { tenantId?: string } {
  const state = cls.get<SignInState | undefined>(SIGN_IN);
  return {
    ...(state?.method && methodMetadata(state.method)),
    // The session store fills in the last chosen tenant when this is absent.
    ...(state?.tenantId && { tenantId: state.tenantId }),
    authenticatedAt: (state?.authenticatedAt ?? new Date()).toISOString(),
  };
}
