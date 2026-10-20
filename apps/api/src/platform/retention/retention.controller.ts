import { Body, Controller, Get, Ip, Param, Put } from '@nestjs/common';
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
import { AccessPolicy } from '../../iam/access/policies.js';
import type { Principal } from '../../iam/auth/principal.js';
import {
  retentionRuleListSchema,
  retentionRuleSchema,
  type SetRetentionDto,
  setRetentionSchema,
} from './retention.schemas.js';
import { RetentionService } from './retention.service.js';

/**
 * The retention rules features declare and the tenant's choice for each
 * (`Access.manageRetention`). The purge runs nightly on the queue.
 */
@ApiTags('retention')
@ApiBearerAuth('api-key')
@ApiBearerAuth('user-token')
@ApiCookieAuth('user-session')
@ApiUnauthorizedResponse({ description: 'No valid API key or session.' })
@ApiForbiddenResponse({ description: 'Not allowed by your permissions.' })
@Controller('retention/rules')
export class RetentionController {
  constructor(private readonly retention: RetentionService) {}

  @Get()
  @Can(AccessPolicy, 'manageRetention')
  @ApiOperation({
    summary: 'The retention rules and the tenant’s choice for each',
    description:
      'A declared rule does nothing until the tenant turns it on. `days` is the age after which a record is purged or anonymised (`action`); records under a legal hold are always kept.',
  })
  @ApiOkResponse({ standardSchema: retentionRuleListSchema })
  list() {
    return this.retention.list();
  }

  @Put(':name')
  @Can(AccessPolicy, 'manageRetention')
  @ApiOperation({
    summary: 'Turn a retention rule on or off, and set its days',
    description:
      'Takes effect at the next nightly run (04:10 in APP_TIMEZONE). Not below the rule’s `minDays`. Audited (`retention.policy-changed`).',
  })
  @ApiOkResponse({ standardSchema: retentionRuleSchema })
  @ApiBadRequestResponse({
    description:
      'An invalid body, or days below the minimum (validation_failed).',
  })
  @ApiNotFoundResponse({ description: 'No rule of this name is declared.' })
  set(
    @CurrentUser() user: Principal,
    @Param('name') name: string,
    @Body({ schema: setRetentionSchema }) dto: SetRetentionDto,
    @Ip() ip: string,
  ) {
    return this.retention.set(user, name, dto, ip);
  }
}
