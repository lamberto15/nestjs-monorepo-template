import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import { Idempotent } from '@nestjs/idempotency';
import {
  ApiAcceptedResponse,
  ApiNotFoundResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { z } from 'zod';
import { AccessPolicy } from '../../iam/access/policies.js';
import { OperatorOnly } from '../../iam/auth/operator-only.js';
import type { UserPrincipal } from '../../iam/auth/principal.js';
import { RecentAuthentication } from '../../iam/auth/recent-authentication.js';
import { startedSchema } from '../data-transfer/data-transfer.schemas.js';
import { TRANSFER_FORMATS } from '../data-transfer/data-transfer.types.js';
import { TenantExports } from './tenant-exports.service.js';

const exportTenantSchema = z
  .object({
    format: z.enum(TRANSFER_FORMATS).default('json'),
  })
  .strict();

/**
 * A tenant's export, for the operators (docs/tenancy.md, "Exporting a
 * tenant"): a data transfer of every record of it (TenantTransfer), queued
 * in a worker, its file behind a link of 30 minutes. Next to
 * TenantsController (iam), whose routes are the tenants' own: the export is
 * the platform's data transfers.
 */
@ApiTags('tenants')
@Controller('tenants')
@OperatorOnly()
export class TenantExportController {
  constructor(private readonly exports: TenantExports) {}

  @Post(':id/export')
  @Can(AccessPolicy, 'manageTenants')
  @RecentAuthentication()
  @Idempotent()
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Export every record of a tenant (operators)',
    description:
      'Answers 202 with the transfer: follow it at GET /v1/data/transfers/{id} (yours, in your tenant; GET /v1/data/transfers lists it), which gives the file’s link when done (valid 30 minutes; ask again for a new one). The connection hears `data.export-ready`. One row per record: `kind` (its table; `tenant`, `member` for its members’ accounts), `id`, `data`; stored credentials’ hashes left out, stored files listed by their rows. Wants a recent sign-in (`reauthentication_required`). Audited (`tenant.export-requested`) in your tenant and in that one.',
  })
  @ApiAcceptedResponse({ standardSchema: startedSchema })
  @ApiNotFoundResponse()
  start(
    @CurrentUser() user: UserPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body({ schema: exportTenantSchema })
    body: z.infer<typeof exportTenantSchema>,
    @Ip() ip: string,
  ) {
    return this.exports.start(user, id, body.format, ip);
  }
}
