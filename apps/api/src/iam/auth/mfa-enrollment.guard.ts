import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { t } from '@nestjs/i18n';
import { WsException } from '@nestjs/websockets';
import { AuthPolicyService } from './auth-policy.service.js';
import type { RequestPrincipal } from './principal.js';

/** The refusal's code (the problem's `code`). */
export const MFA_ENROLLMENT_REQUIRED = 'mfa_enrollment_required';

const DURING_ENROLLMENT = Symbol('mfa-enrollment-allowed');

/**
 * A route a user who must still set up two-factor (`auth.requireMfa`) may
 * reach: setting it up (`/auth/mfa`, `/enroll`, `/confirm`), what it needs
 * (re-authenticating for the step-up), who am I, and leaving (signing out,
 * choosing another tenant, whose policy may differ).
 */
export const DuringMfaEnrollment = () => SetMetadata(DURING_ENROLLMENT, true);

/**
 * `auth.requireMfa` (docs/auth.md, "Policies"): a user whose tenant (or
 * team) requires two-factor and who has none signs in as usual, but the
 * session (or token) is restricted: every route but those marked
 * `@DuringMfaEnrollment()` answers 403 `mfa_enrollment_required`. Once the
 * authenticator is confirmed, the same session is a normal one (the check
 * runs on every request; nothing is stored on the session).
 *
 * Custom: @nestjs/authentication's second factor applies to users who
 * enrolled (a pending session, `@Authenticate({ mfa: true })`), and has no
 * hook that makes a user enroll; the rule depends on the tenant's
 * settings, read per request. A global guard right after the
 * authentication guard (PrincipalGuard, which sets the request's tenant)
 * and before the authorization guard, so the refusal comes before any
 * permission's. API clients and impersonations are never restricted
 * (AuthPolicyService); routes without a principal (`@Public()`) neither.
 */
@Injectable()
export class MfaEnrollmentGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly policy: AuthPolicyService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const type = context.getType();
    if (type !== 'http' && type !== 'ws') {
      return true;
    }
    const principal = (
      type === 'http'
        ? context.switchToHttp().getRequest<{ user?: RequestPrincipal }>()
        : context.switchToWs().getClient<{ user?: RequestPrincipal }>()
    ).user;
    if (
      !principal ||
      this.reflector.getAllAndOverride<boolean>(DURING_ENROLLMENT, [
        context.getHandler(),
        context.getClass(),
      ])
    ) {
      return true;
    }
    if (!(await this.policy.mfaEnrollmentRequired(principal))) {
      return true;
    }
    const message = t('auth.mfaEnrollmentRequired');
    if (type === 'ws') {
      throw new WsException({
        status: 'error',
        statusCode: 403,
        errorCode: MFA_ENROLLMENT_REQUIRED,
        message,
      });
    }
    throw new ForbiddenException({ code: MFA_ENROLLMENT_REQUIRED, message });
  }
}
