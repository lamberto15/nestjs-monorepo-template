import {
  Controller,
  ForbiddenException,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { RequiresSwitch } from '../../iam/auth/deployment-switch.js';
import { AccessPolicy } from '../../iam/access/policies.js';
import type { Principal } from '../../iam/auth/principal.js';
import {
  type UsageQuery,
  usageQuerySchema,
  usageReportSchema,
} from './usage.schemas.js';
import { UsageService } from './usage.service.js';

/**
 * API clients' usage: requests per UTC day and route, today included. An
 * administrator reads any client's (Access.manageClients, next to the
 * client's routes); a client reads its own.
 */
@ApiTags('usage')
@ApiUnauthorizedResponse({ description: 'No valid API key or session.' })
@Controller()
export class UsageController {
  constructor(private readonly usage: UsageService) {}

  @Get('access/clients/:id/usage')
  @RequiresSwitch('API_CLIENTS')
  @Can(AccessPolicy, 'manageClients')
  @ApiTags('access')
  @ApiBearerAuth('user-token')
  @ApiCookieAuth('user-session')
  @ApiOperation({
    summary: "An API client's requests per day and route",
    description:
      'UTC days from `from` to `to`, both included (default: the last 30 days, at most 400). Today counts live.',
  })
  @ApiOkResponse({ standardSchema: usageReportSchema })
  @ApiBadRequestResponse({
    description:
      'A range that ends before it starts, or is longer than 400 days.',
  })
  @ApiForbiddenResponse({ description: 'Not allowed by your permissions.' })
  @ApiNotFoundResponse()
  clientUsage(
    @Param('id', ParseUUIDPipe) id: string,
    @Query({ schema: usageQuerySchema }) query: UsageQuery,
  ) {
    return this.usage.forClient(id, query);
  }

  @Get('usage')
  @Can.Anyone()
  @ApiBearerAuth('api-key')
  @ApiOperation({
    summary: 'Your requests per day and route (API clients)',
    description:
      'UTC days from `from` to `to`, both included (default: the last 30 days, at most 400). Today counts live. With a daily quota, every response carries X-Quota-Limit and X-Quota-Remaining.',
  })
  @ApiOkResponse({ standardSchema: usageReportSchema })
  @ApiBadRequestResponse({
    description:
      'A range that ends before it starts, or is longer than 400 days.',
  })
  @ApiForbiddenResponse({
    description: 'Only API clients have usage: a user gets a 403.',
  })
  ownUsage(
    @CurrentUser() principal: Principal,
    @Query({ schema: usageQuerySchema }) query: UsageQuery,
  ) {
    if (principal.kind !== 'client') {
      throw new ForbiddenException(
        'Usage is counted for API clients only; administrators read it at /v1/access/clients/{id}/usage.',
      );
    }
    return this.usage.report(principal.id, query);
  }
}
