import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { t } from '@nestjs/i18n';
import { WsException } from '@nestjs/websockets';
import { DURING_ONBOARDING, ONBOARDING_REQUIRED } from './onboarding.js';
import type { RequestPrincipal } from './principal.js';

/**
 * The first administrator's onboarding (docs/auth.md, "Administrator
 * onboarding"): while the seeded address is a placeholder or unproved, or
 * the generated password is unchanged (`users.onboarding_*`, carried by the
 * principal), every route but those marked `@DuringOnboarding()` answers 403
 * `onboarding_required`. Done, the same session is a normal one (checked on
 * every request).
 *
 * Custom, as MfaEnrollmentGuard (which it follows): the package has no
 * "must change credentials first" state. API clients and impersonations are
 * never restricted; public routes have no principal.
 */
@Injectable()
export class OnboardingGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
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
      principal?.kind !== 'user' ||
      principal.impersonator ||
      !principal.onboarding ||
      this.reflector.getAllAndOverride<boolean>(DURING_ONBOARDING, [
        context.getHandler(),
        context.getClass(),
      ])
    ) {
      return true;
    }
    const message = t('auth.onboardingRequired');
    if (type === 'ws') {
      throw new WsException({
        status: 'error',
        statusCode: 403,
        errorCode: ONBOARDING_REQUIRED,
        message,
      });
    }
    throw new ForbiddenException({ code: ONBOARDING_REQUIRED, message });
  }
}
