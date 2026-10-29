import {
  Controller,
  Get,
  HttpCode,
  Ip,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import {
  ApiAcceptedResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Principal } from '../../iam/auth/principal.js';
import { DataQualityPolicy } from './data-quality.policy.js';
import {
  dataQualityFindingPageSchema,
  dataQualityFindingSchema,
  dataQualityScanSchema,
  dataQualitySummarySchema,
  type FindingsQuery,
  findingsQuerySchema,
  recheckResultSchema,
} from './data-quality.schemas.js';
import { DataQualityService } from './data-quality.service.js';

/**
 * The data-quality dashboard (docs/data-quality.md): findings per subject,
 * scans on the queue, dismissal and recheck. Nothing here changes a record.
 */
@ApiTags('data-quality')
@ApiBearerAuth('api-key')
@ApiBearerAuth('user-token')
@ApiCookieAuth('user-session')
@ApiUnauthorizedResponse({ description: 'No valid API key or session.' })
@ApiForbiddenResponse({ description: 'Not allowed by your permissions.' })
@Controller('data-quality')
export class DataQualityController {
  constructor(private readonly quality: DataQualityService) {}

  @Get()
  @Can(DataQualityPolicy, 'read')
  @ApiOperation({
    summary: 'Open findings per subject, and the last scan',
    description:
      'Counts only the findings you may see: on records you may read, on fields shown to you. `lastScan` says how fresh they are, and how far a running scan got.',
  })
  @ApiOkResponse({ standardSchema: dataQualitySummarySchema })
  summary(@CurrentUser() user: Principal) {
    return this.quality.summary(user);
  }

  @Post('scans')
  @HttpCode(202)
  @Can(DataQualityPolicy, 'manage')
  @ApiOperation({
    summary: 'Scan every record again',
    description: `Runs on the queue in batches; follow it at GET /v1/data-quality (\`lastScan\`). It adds the findings that hold and deletes those that no longer do; dismissed ones stay dismissed. Audited \`data-quality.scan-started\`.`,
  })
  @ApiAcceptedResponse({ standardSchema: dataQualityScanSchema })
  @ApiConflictResponse({
    description: 'A scan is already running (scan_running).',
  })
  scan(@CurrentUser() user: Principal, @Ip() ip: string) {
    return this.quality.startScan(user, ip);
  }

  @Get('subjects/:subject/findings')
  @Can(DataQualityPolicy, 'read')
  @ApiOperation({
    summary: 'A page of one subject’s findings',
    description:
      'Open ones unless `dismissed=true`; newest first. Only those on records you may read and fields shown to you.',
  })
  @ApiOkResponse({ standardSchema: dataQualityFindingPageSchema })
  @ApiNotFoundResponse({
    description: 'No checks for this subject (subject_not_found).',
  })
  findings(
    @CurrentUser() user: Principal,
    @Param('subject') subject: string,
    @Query({ schema: findingsQuerySchema }) query: FindingsQuery,
  ) {
    return this.quality.findings(user, subject, query);
  }

  @Post('findings/:id/dismiss')
  @HttpCode(200)
  @Can(DataQualityPolicy, 'manage')
  @ApiOperation({
    summary: 'Dismiss a finding: right as it is',
    description:
      'It stays dismissed while it holds; one that stops holding and comes back is new. Audited `data-quality.finding-dismissed`.',
  })
  @ApiOkResponse({ standardSchema: dataQualityFindingSchema })
  @ApiNotFoundResponse({
    description: 'No finding with this id that you may see.',
  })
  dismiss(
    @CurrentUser() user: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Ip() ip: string,
  ) {
    return this.quality.dismiss(user, id, ip);
  }

  @Post('findings/:id/recheck')
  @HttpCode(200)
  @Can(DataQualityPolicy, 'manage')
  @ApiOperation({
    summary: 'Check a finding’s record again now',
    description:
      'Its record’s findings are brought up to date; `resolved` when this one no longer holds.',
  })
  @ApiOkResponse({ standardSchema: recheckResultSchema })
  @ApiNotFoundResponse({
    description: 'No finding with this id that you may see.',
  })
  recheck(
    @CurrentUser() user: Principal,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.quality.recheck(user, id);
  }
}
