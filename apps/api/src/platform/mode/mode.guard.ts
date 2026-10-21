import {
  type CanActivate,
  type ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { t } from '@nestjs/i18n';
import { ALLOW_IN_MAINTENANCE } from '../../core/http/maintenance.js';
import { ModeService } from './mode.service.js';

/** The methods that only read. */
const READS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Seconds a refused client is told to wait (Retry-After). */
export const MODE_RETRY_AFTER_SECONDS = 30;

/**
 * `platform.mode` (docs/settings.md): while `read-only`, every request that
 * writes (not GET, HEAD or OPTIONS) answers 503 `read_only`; while
 * `maintenance`, every request does, 503 `maintenance`, both with
 * Retry-After. A route marked `@AllowInMaintenance()` is never refused
 * (health, sign-in, the operators' routes). A global guard, not a route
 * guard: it runs on every route and needs no principal, so it is cheap
 * (ModeService keeps the mode for a second). WebSocket messages are not
 * covered: realtime only pushes what an HTTP write already did.
 */
@Injectable()
export class ModeGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly mode: ModeService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') {
      return true;
    }
    const mode = await this.mode.get();
    if (mode === 'normal') {
      return true;
    }
    const request = context.switchToHttp().getRequest<{ method: string }>();
    if (mode === 'read-only' && READS.has(request.method)) {
      return true;
    }
    const allowed = this.reflector.getAllAndOverride<boolean | undefined>(
      ALLOW_IN_MAINTENANCE,
      [context.getHandler(), context.getClass()],
    );
    if (allowed) {
      return true;
    }
    const code = mode === 'read-only' ? 'read_only' : 'maintenance';
    throw new HttpException(
      {
        code,
        message: t(mode === 'read-only' ? 'mode.readOnly' : 'mode.maintenance'),
        retryAfter: MODE_RETRY_AFTER_SECONDS,
      },
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }
}
