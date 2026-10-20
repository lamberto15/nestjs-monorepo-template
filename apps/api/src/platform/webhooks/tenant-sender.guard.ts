import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ClsServiceManager } from 'nestjs-cls';
import { TENANT_SCOPE, tenantScope } from '../../core/tenancy/tenant-scope.js';
import { IncomingSendersService } from './incoming-senders.service.js';
import { TENANT_SENDER } from './tenant-sender.scheme.js';

/**
 * Finds the sender the URL names, inside the tenant it names, before
 * `@VerifyWebhook()` checks the signature: the secrets to verify with are
 * that sender's, and the rest of the request (the handler, the inbox) runs
 * in its tenant. An unknown tenant, an unknown, disabled or other tenant's
 * sender: all the same 401 as a bad signature, so nothing says which exists.
 */
@Injectable()
export class TenantSenderGuard implements CanActivate {
  constructor(private readonly senders: IncomingSendersService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{
      params: { tenantId?: string; name?: string };
    }>();
    const { tenantId, name } = request.params;
    const sender =
      tenantId && name ? await this.senders.resolve(tenantId, name) : null;
    if (!sender) {
      throw new UnauthorizedException('Webhook signature verification failed');
    }
    const cls = ClsServiceManager.getClsService();
    cls.set(TENANT_SENDER, sender);
    cls.set(TENANT_SCOPE, tenantScope(sender.tenantId));
    return true;
  }
}
