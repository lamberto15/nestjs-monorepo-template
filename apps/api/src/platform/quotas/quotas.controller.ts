import {
  Body,
  Controller,
  Get,
  Ip,
  Param,
  ParseUUIDPipe,
  Put,
} from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import {
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { z } from 'zod';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { AccessPolicy } from '../../iam/access/policies.js';
import { OperatorOnly } from '../../iam/auth/operator-only.js';
import type { UserPrincipal } from '../../iam/auth/principal.js';
import { tenantUsageSchema, updateQuotasSchema } from './quota.schemas.js';
import { QuotasService } from './quotas.service.js';

/**
 * Any tenant's use and limits, and the operators' per tenant limits
 * (docs/tenancy.md, "Quotas"). Next to TenantsController (iam), as the
 * tenant export is.
 */
@ApiTags('tenants')
@Controller('tenants')
@OperatorOnly()
export class TenantQuotasController {
  constructor(private readonly quotas: QuotasService) {}

  @Get(':id/usage')
  @Can(AccessPolicy, 'manageTenants')
  @ApiOperation({
    summary: 'What a tenant uses against its limits (operators)',
    description:
      'Members, API clients, stored bytes and each feature’s records: `used` and `limit` (null: unlimited), and the limits the operators set for it.',
  })
  @ApiOkResponse({ standardSchema: tenantUsageSchema })
  @ApiNotFoundResponse()
  usage(@Param('id', ParseUUIDPipe) id: string) {
    return this.quotas.usage(id);
  }

  @Put(':id/quotas')
  @Can(AccessPolicy, 'manageTenants')
  @ApiOperation({
    summary: 'Set the limits of a tenant (operators)',
    description:
      'Merged into its limits: a number sets one, `null` removes the tenant’s own (the deployment’s default, the `quotas.*` platform settings, holds again), an absent key stays. A limit below the current use refuses what is made next; nothing existing is deleted. Past a limit, creating answers 422 `quota_exceeded` with `quota: { resource, limit, used }`. Audited (`tenant.quotas-changed`) in your tenant and in that one.',
  })
  @ApiOkResponse({ standardSchema: tenantUsageSchema })
  @ApiNotFoundResponse()
  update(
    @CurrentUser() user: UserPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body({ schema: updateQuotasSchema })
    body: z.infer<typeof updateQuotasSchema>,
    @Ip() ip: string,
  ) {
    return this.quotas.update(user, id, body, ip);
  }
}

/** The caller’s own tenant’s use and limits, for its administrators. */
@ApiTags('tenants')
@Controller('tenant')
export class OwnQuotasController {
  constructor(
    private readonly quotas: QuotasService,
    private readonly tenancy: Tenancy,
  ) {}

  @Get('usage')
  @Can(AccessPolicy, 'manageSettings')
  @ApiOperation({
    summary: 'What your tenant uses against its limits',
    description:
      'Members, API clients, stored bytes and each feature’s records: `used` and `limit` (null: unlimited). Past a limit, creating answers 422 `quota_exceeded`.',
  })
  @ApiOkResponse({ standardSchema: tenantUsageSchema })
  usage() {
    return this.quotas.usage(this.tenancy.tenantId());
  }
}
