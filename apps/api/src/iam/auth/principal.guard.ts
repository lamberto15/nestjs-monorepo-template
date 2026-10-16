import {
  type ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthenticationGuard } from '@nestjs/authentication';
import { WsException } from '@nestjs/websockets';

/** The refusal's code (Nest's `errorCode`, the problem's `code`). */
export const SYSTEM_PRINCIPAL_REFUSED = 'system_principal_refused';

/**
 * @nestjs/authentication's guard, and one rule on top: whatever a
 * credential provider returns, the system principal (work without a user,
 * docs/permissions.md) never acts for a request or a socket message. No
 * provider makes one today (they load users and API clients from the
 * database); this is the line a future provider (SCIM tokens, a gateway's
 * header) can't cross by mistake. Registered instead of the package's own
 * global guard (`globalGuard: false`), at the same place in the chain:
 * before @nestjs/authorization's, which checks that at startup (it knows
 * subclasses by the guard's brand).
 */
@Injectable()
export class PrincipalGuard extends AuthenticationGuard {
  private readonly logger = new Logger('Authentication');

  override async canActivate(context: ExecutionContext): Promise<boolean> {
    const allowed = await super.canActivate(context);
    const carrier = carrierOf(context);
    const user = carrier?.user as { kind?: string } | undefined;
    if (user?.kind === 'system') {
      // As the package's own refusals do: a socket keeps no principal it was refused.
      carrier!.user = null;
      this.logger.error(
        'A credential provider returned the system principal: refused.',
      );
      const body = {
        statusCode: 401,
        message: 'The system principal cannot authenticate a request.',
        errorCode: SYSTEM_PRINCIPAL_REFUSED,
      };
      throw context.getType() === 'ws'
        ? new WsException({ status: 'error', ...body })
        : new UnauthorizedException(body.message, {
            errorCode: SYSTEM_PRINCIPAL_REFUSED,
            description: SYSTEM_PRINCIPAL_REFUSED,
          });
    }
    return allowed;
  }
}

/** Where the package mirrors the result as `user`: the request, or the socket. */
function carrierOf(context: ExecutionContext): { user?: unknown } | undefined {
  switch (context.getType()) {
    case 'http':
      return context.switchToHttp().getRequest();
    case 'ws':
      return context.switchToWs().getClient();
    default:
      return undefined;
  }
}
