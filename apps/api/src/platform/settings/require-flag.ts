import {
  applyDecorators,
  type CanActivate,
  type ExecutionContext,
  Injectable,
  NotFoundException,
  UseGuards,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiNotFoundResponse } from '@nestjs/swagger';
import type { Principal } from '../../iam/auth/principal.js';
import type { SettingDeclaration } from './setting.types.js';
import { SettingsService } from './settings.service.js';

/** The flag a route or controller needs (Nest's `Reflector.createDecorator`). */
const REQUIRED_FLAG = Reflector.createDecorator<SettingDeclaration<boolean>>();

/**
 * Answers 404 while the route's flag is off for the caller (their value:
 * docs/settings.md, "Precedence"), as if the route did not exist. Route
 * guards run after the global ones, so the principal and its tenant are
 * known.
 */
@Injectable()
export class FlagGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly settings: SettingsService,
  ) {}

  async canActivate(context: ExecutionContext) {
    const flag = this.reflector.getAllAndOverride(REQUIRED_FLAG, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!flag) {
      return true;
    }
    const principal =
      context.switchToHttp().getRequest<{ user?: Principal }>().user ?? null;
    if (!(await this.settings.enabled(flag, principal))) {
      throw new NotFoundException();
    }
    return true;
  }
}

/**
 * A route (or every route of a controller) that exists only while the
 * flag is on for the caller; off, it is a 404.
 *
 * ```ts
 * @Get('beta')
 * @RequireFlag(NOTE_BETA)
 * beta() { … }
 * ```
 */
export const RequireFlag = (flag: SettingDeclaration<boolean>) =>
  applyDecorators(
    REQUIRED_FLAG(flag),
    UseGuards(FlagGuard),
    ApiNotFoundResponse({
      description: `Also while the \`${flag.key}\` flag is off for you.`,
    }),
  );
