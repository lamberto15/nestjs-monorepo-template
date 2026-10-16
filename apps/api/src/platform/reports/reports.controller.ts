import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import { Idempotent } from '@nestjs/idempotency';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiHeader,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { ListQuery } from '../../core/http/list-query.js';
import { pageSchema } from '../../core/http/pagination.js';
import type { RequestPrincipal } from '../../iam/auth/principal.js';
import { idempotencyKeyHeader } from '../idempotency/idempotency.openapi.js';
import { REPORT_LIST } from './report.list.js';
import {
  type CreateReportDto,
  createReportSchema,
  reportRunSchema,
  reportSchema,
  type UpdateReportDto,
  updateReportSchema,
} from './report.schemas.js';
import { ReportsService } from './reports.service.js';

const VALIDATION =
  'An export you may not run (`exporter`), filters it refuses (`filters.<field>`), an unknown time zone, a schedule out of range, more than 20 recipients (validation_failed).';

/**
 * Scheduled reports: an export run for you on a schedule, its file mailed
 * to the recipients with a link. Users and API clients each see and
 * change only their own (another's is a 404); what may be exported is
 * what `GET /v1/data` lists for the caller.
 */
@ApiTags('reports')
@ApiBearerAuth('api-key')
@ApiBearerAuth('user-token')
@ApiCookieAuth('user-session')
@ApiUnauthorizedResponse({ description: 'No valid API key or session.' })
@Can.Anyone() // Each report is its owner's; the export's own permission is checked.
@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get()
  @ApiOperation({
    summary: 'Your scheduled reports',
    description:
      '`?active=true`, `?exporter=notes`, `?name.contains=`, `?sort=nextRunAt`; newest first; cursor pages.',
  })
  @ApiOkResponse({ standardSchema: pageSchema(reportSchema) })
  async list(
    @CurrentUser() user: RequestPrincipal,
    @Query({ schema: REPORT_LIST.schema }) query: ListQuery,
  ) {
    return REPORT_LIST.pick(await this.reports.page(user, query), query);
  }

  @Post()
  @Idempotent()
  @ApiOperation({
    summary: 'Schedule a report',
    description:
      'An export (`exporter`, `format`, `filters`, as `POST /v1/data/exports` takes them) run daily, weekly or monthly at an hour of `timezone`; the recipients get a download link (for REPORT_LINK_TTL, 24h by default). At most 20 active reports. Audited (`report.created`).',
  })
  @ApiHeader(idempotencyKeyHeader(false))
  @ApiCreatedResponse({ standardSchema: reportSchema })
  @ApiBadRequestResponse({ description: VALIDATION })
  create(
    @CurrentUser() user: RequestPrincipal,
    @Body({ schema: createReportSchema }) dto: CreateReportDto,
    @Ip() ip: string,
  ) {
    return this.reports.create(user, dto, ip);
  }

  @Get(':id')
  @ApiOperation({ summary: 'One of your scheduled reports' })
  @ApiOkResponse({ standardSchema: reportSchema })
  @ApiNotFoundResponse()
  get(
    @CurrentUser() user: RequestPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.reports.get(user, id);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Change a scheduled report',
    description:
      'Only what is sent changes; the next run is computed again. Audited (`report.updated`).',
  })
  @ApiOkResponse({ standardSchema: reportSchema })
  @ApiBadRequestResponse({ description: VALIDATION })
  @ApiNotFoundResponse()
  update(
    @CurrentUser() user: RequestPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body({ schema: updateReportSchema }) dto: UpdateReportDto,
    @Ip() ip: string,
  ) {
    return this.reports.update(user, id, dto, ip);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete a scheduled report',
    description: 'Audited (`report.deleted`).',
  })
  @ApiNoContentResponse()
  @ApiNotFoundResponse()
  async remove(
    @CurrentUser() user: RequestPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Ip() ip: string,
  ) {
    await this.reports.remove(user, id, ip);
  }

  @Post(':id/run')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Run a report now',
    description:
      'Starts its export (a background job; `GET /v1/data/transfers/{id}` follows it); the recipients get the link when it is done. The schedule is unchanged. Audited (`report.ran`).',
  })
  @ApiAcceptedResponse({ standardSchema: reportRunSchema })
  @ApiBadRequestResponse({
    description: 'You may no longer run its export (validation_failed).',
  })
  @ApiNotFoundResponse()
  run(
    @CurrentUser() user: RequestPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Ip() ip: string,
  ) {
    return this.reports.runNow(user, id, ip);
  }
}
