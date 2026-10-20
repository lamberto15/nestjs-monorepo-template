import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ClsServiceManager } from 'nestjs-cls';
import {
  readOnlyTenantScope,
  TENANT_SCOPE,
} from '../../core/tenancy/tenant-scope.js';
import type { RequestPrincipal } from '../auth/principal.js';
import {
  BREAK_GLASS_HEADER,
  BreakGlassService,
} from './break-glass.service.js';

/** The methods a break-glass request may use: reading only. */
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * A request that names a break-glass grant (`Break-Glass: <grant id>`,
 * docs/tenancy.md "Break-glass") reads the tenant the grant opened, read
 * only. A global guard after the authentication guard (PrincipalGuard,
 * which set the operator's own tenant) and the two-factor one, and before
 * authorization's, so the permission checks see the tenant it moved to.
 *
 * The grant is checked on every request (BreakGlassService.resolve()):
 * still the operator's, open, unexpired, the permission still held, the
 * tenant not opted out. Then the principal acts in that tenant (the same
 * object `@CurrentUser()` and the authorization guard read, changed in
 * place: @nestjs/authentication keeps no other copy), and the request's
 * scope is that tenant's, read only: PostgreSQL refuses any write of it.
 * A request that isn't a read is refused here first (403
 * `break_glass_read_only`). HTTP only: a socket never breaks glass.
 *
 * Custom: neither @nestjs/authentication nor @nestjs/authorization has a
 * notion of acting in another tenant.
 */
@Injectable()
export class BreakGlassGuard implements CanActivate {
  private readonly logger = new Logger('BreakGlass');

  constructor(private readonly breakGlass: BreakGlassService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') {
      return true;
    }
    const request = context.switchToHttp().getRequest<{
      method: string;
      originalUrl?: string;
      headers: Record<string, string | string[] | undefined>;
      user?: RequestPrincipal | null;
    }>();
    const header = request.headers[BREAK_GLASS_HEADER];
    if (header === undefined) {
      return true;
    }
    const user = request.user;
    const grantId = Array.isArray(header) ? header[0] : header;
    if (user?.kind !== 'user' || !grantId) {
      throw new ForbiddenException({
        code: 'break_glass_invalid',
        message: 'Break-glass is for a signed-in operator, with a grant id.',
      });
    }
    const { tenantId, expiresAt } = await this.breakGlass.resolve(
      user,
      grantId,
    );
    if (!SAFE.has(request.method.toUpperCase())) {
      throw new ForbiddenException({
        code: 'break_glass_read_only',
        message: 'Break-glass access is read only.',
      });
    }
    const operatorTenantId = user.tenantId!;
    user.tenantId = tenantId;
    user.breakGlass = {
      grantId,
      operatorTenantId,
      expiresAt: expiresAt.toISOString(),
    };
    ClsServiceManager.getClsService().set(
      TENANT_SCOPE,
      readOnlyTenantScope(tenantId),
    );
    this.logger.log(
      `${user.email} reads tenant ${tenantId} (grant ${grantId}): ${request.method} ${request.originalUrl ?? ''}`,
    );
    return true;
  }
}
