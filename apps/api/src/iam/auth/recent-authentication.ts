import {
  applyDecorators,
  type CanActivate,
  type ExecutionContext,
  Injectable,
  SetMetadata,
  UseGuards,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiForbiddenResponse } from '@nestjs/swagger';
import type { Request } from 'express';
import { ReauthenticationService } from '../account/reauthentication.service.js';
import type { RequestPrincipal } from './principal.js';

export interface RecentAuthenticationOptions {
  /** How recent, in minutes; default REAUTHENTICATION_MAX_AGE_MINUTES (10). */
  maxAgeMinutes?: number;
  /** Only when this holds for the request (e.g. a body field that changes a credential). */
  when?: (request: Request) => boolean;
}

const RECENT_AUTHENTICATION = Symbol('recent-authentication');

/**
 * A sensitive route: the user must have signed in or re-authenticated
 * (POST /auth/reauthenticate) within the last `maxAgeMinutes`, else 403
 * `reauthentication_required`, which lists how they can. Never while
 * impersonating (403). API clients have no sign-in to repeat: not checked.
 *
 * Custom: `@nestjs/authentication` has the second factor's step-up
 * (`@Authenticate({ mfa: true })`) but no authentication age. Runs after the
 * global authentication and authorization guards, so a caller without the
 * permission gets that 403 first.
 */
export const RecentAuthentication = (
  options: RecentAuthenticationOptions = {},
) =>
  applyDecorators(
    SetMetadata(RECENT_AUTHENTICATION, options),
    UseGuards(RecentAuthenticationGuard),
    ApiForbiddenResponse({
      description:
        '`reauthentication_required`: no sign-in in the last REAUTHENTICATION_MAX_AGE_MINUTES: re-authenticate (POST /auth/reauthenticate, or sign in again: the problem lists `methods`) and retry. Or not allowed: your permissions, or acting as another user.',
    }),
  );

@Injectable()
export class RecentAuthenticationGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly reauthentication: ReauthenticationService,
  ) {}

  async canActivate(context: ExecutionContext) {
    const options = this.reflector.getAllAndOverride<
      RecentAuthenticationOptions | undefined
    >(RECENT_AUTHENTICATION, [context.getHandler(), context.getClass()]);
    if (!options) {
      return true;
    }
    if (context.getType() !== 'http') {
      return false; // HTTP routes only: fail closed elsewhere
    }
    const request = context
      .switchToHttp()
      .getRequest<
        Request & { user?: RequestPrincipal | null; session?: unknown }
      >();
    if (options.when && !options.when(request)) {
      return true;
    }
    await this.reauthentication.assertRecent(
      request.user ?? null,
      request.session,
      options.maxAgeMinutes,
    );
    return true;
  }
}
