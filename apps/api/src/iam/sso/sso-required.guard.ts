import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { t } from '@nestjs/i18n';
import { WsException } from '@nestjs/websockets';
import { authenticationOf } from '../auth/authentication-method.js';
import type { RequestPrincipal } from '../auth/principal.js';
import {
  SSO_REQUIRED,
  ssoRequired,
  SsoPolicyService,
} from './sso-policy.service.js';

const WITHOUT_SSO = Symbol('sso-not-needed');

/**
 * A route a session refused by "SSO required" may still reach: who am I,
 * leaving (signing out, choosing another of one's tenants) and accepting an
 * invitation to another tenant.
 */
export const WithoutSso = () => SetMetadata(WITHOUT_SSO, true);

/**
 * "SSO required" on every request (docs/auth.md, "SSO required"): a user
 * whose session or token acts in a tenant that requires SSO, and was not
 * signed in through one of its connections, gets 403 `sso_required` unless
 * exempted, on every route but those marked `@WithoutSso()`. Nothing is
 * stored on the session: turning the policy on restricts sessions already
 * open, off frees them.
 *
 * A global guard after MfaEnrollmentGuard (the principal and its tenant are
 * known) and before authorization. Never restricted: API clients (a
 * system, with its own key: SCIM's among them), impersonations (the
 * administrator signed in, not the user), public routes.
 *
 * Custom, as MfaEnrollmentGuard: the rule is the tenant's, read per
 * request; @nestjs/authentication has no per-tenant sign-in method rule.
 */
@Injectable()
export class SsoRequiredGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly policy: SsoPolicyService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const type = context.getType();
    if (type !== 'http' && type !== 'ws') {
      return true;
    }
    // The package mirrors the credential's session (or token claims) on
    // the request, and on a socket's client alike.
    const carrier =
      type === 'http'
        ? context
            .switchToHttp()
            .getRequest<{ user?: RequestPrincipal; session?: unknown }>()
        : context
            .switchToWs()
            .getClient<{ user?: RequestPrincipal; session?: unknown }>();
    const principal = carrier.user;
    if (
      principal?.kind !== 'user' ||
      principal.impersonator ||
      !principal.tenantId ||
      this.reflector.getAllAndOverride<boolean>(WITHOUT_SSO, [
        context.getHandler(),
        context.getClass(),
      ])
    ) {
      return true;
    }
    if (
      await this.policy.allows(
        principal.tenantId,
        principal.id,
        authenticationOf(carrier.session),
      )
    ) {
      return true;
    }
    if (type === 'ws') {
      throw new WsException({
        status: 'error',
        statusCode: 403,
        errorCode: SSO_REQUIRED,
        message: t('auth.ssoRequired'),
      });
    }
    throw ssoRequired();
  }
}
