import {
  applyDecorators,
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  UseGuards,
} from '@nestjs/common';
import { ApiForbiddenResponse } from '@nestjs/swagger';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import type { Principal } from './principal.js';

/**
 * The deployment's operators only (docs/tenancy.md, "Operators"): a route
 * that sees past one tenant (the queues and the outbox of every tenant, the
 * mail suppression list of every address) answers only a principal acting
 * in the operator tenant (`tenants.operator`, the one the first start
 * seeds), on top of its permission; anyone else gets 403
 * `operator_required`, whatever their roles in their own tenant. Roadmap
 * 1b replaces it with the platform's super tenant.
 */
@Injectable()
export class OperatorGuard implements CanActivate {
  constructor(private readonly tenancy: Tenancy) {}

  async canActivate(context: ExecutionContext) {
    const principal = context
      .switchToHttp()
      .getRequest<{ user?: Principal }>().user;
    const tenantId =
      principal && principal.kind !== 'system' ? principal.tenantId : null;
    const tenant = tenantId ? await this.tenancy.find(tenantId) : undefined;
    if (!tenant?.operator || !tenant.active) {
      throw new ForbiddenException({
        code: 'operator_required',
        message:
          'Only the operators of this deployment may do this: it reaches past your tenant.',
      });
    }
    return true;
  }
}

/** Marks a controller or route as the operators' (OperatorGuard). */
export const OperatorOnly = () =>
  applyDecorators(
    UseGuards(OperatorGuard),
    ApiForbiddenResponse({
      description:
        'operator_required: the caller does not act in the operator tenant.',
    }),
  );
