import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import {
  ApiBearerAuth,
  ApiCookieAuth,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { z } from 'zod';
import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  pageSchema,
} from '../../core/http/pagination.js';
import type { Principal, RequestPrincipal } from '../../iam/auth/principal.js';
import { jobStatusFilter } from '../queues/job-status.js';
import { bulkRunSchema, bulkStatusSchema } from './bulk.schemas.js';
import { BulkService } from './bulk.service.js';
import { BULK_KINDS } from './bulk.types.js';

const runsQuerySchema = z.object({
  status: jobStatusFilter,
  kind: z
    .enum(BULK_KINDS)
    .optional()
    .describe(
      "Only runs of this action: delete, restore or update (the one the record routes call change). Default: all. A run's `action` is what it matches.",
    ),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  cursor: z.uuid().optional().describe('`nextCursor` of the previous page.'),
});

/**
 * The bulk runs a feature's `POST /<x>/bulk` handed to the workers: their
 * progress, then their result. Only to the principal who started them.
 */
@ApiTags('bulk')
@ApiBearerAuth('api-key')
@ApiBearerAuth('user-token')
@ApiCookieAuth('user-session')
@Can.Anyone() // Only the principal who started the run sees it.
@Controller('bulk')
export class BulkController {
  constructor(private readonly bulk: BulkService) {}

  @Get()
  @ApiOperation({
    summary: 'The bulk runs you handed to the workers in this tenant',
    description:
      'Newest first, by cursor (`limit`, `cursor` = the previous `nextCursor`); `?status=` and `?kind=` keep some (a filtered page may hold fewer than `limit` items, or none, while `nextCursor` is set: follow it until it is null). Each item as GET /v1/bulk/{id} tells it, without the result per item (its counts stay). Runs answered in the request (200) were never jobs and are not listed; finished ones are kept 7 days.',
  })
  @ApiOkResponse({ standardSchema: pageSchema(bulkRunSchema) })
  list(
    @CurrentUser() user: RequestPrincipal,
    @Query({ schema: runsQuerySchema }) query: z.infer<typeof runsQuerySchema>,
  ) {
    return this.bulk.list(user, query);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'A bulk run you started: progress, then the result per item',
    description:
      'The realtime connection hears `bulk.finished { id, name, action, done, failed }` when it ends.',
  })
  @ApiOkResponse({ standardSchema: bulkStatusSchema })
  @ApiNotFoundResponse()
  status(
    @CurrentUser() user: Principal,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.bulk.status(user, id);
  }
}
