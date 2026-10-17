import {
  Body,
  HttpCode,
  HttpStatus,
  Ip,
  Post,
  Res,
  type Type,
} from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { Response } from 'express';
import type { RequestPrincipal } from '../../iam/auth/principal.js';
import { RecordIdempotent } from '../records/record-idempotency.js';
import {
  namedController,
  operationIdOf,
  RecordController,
  type RecordRouteSpec,
} from '../records/record-routes.js';
import { bulkResultSchema, bulkStartedSchema } from './bulk.schemas.js';
import { type BulkRequest, BulkService } from './bulk.service.js';

export interface BulkRouteOptions {
  /** The feature's BulkOperation (`name`): `notes`. */
  name: string;
  /** The body: `bulkRequestSchema(actions, input)` (bulk.schemas.ts). */
  body: StandardSchemaV1;
  /** Which actions the feature offers, in its words. */
  docs: { summary: string; description: string };
}

/**
 * `POST /<path>/bulk`: many records at once, each as its own route does it
 * (BulkService, through the feature's BulkOperation); 200 with a result
 * per record, or 202 with a background job.
 */
export function bulkRoutes(
  spec: RecordRouteSpec,
  options: BulkRouteOptions,
): Type {
  @ApiForbiddenResponse({ description: 'Not allowed by your permissions.' })
  @RecordController(spec, spec.path)
  class BulkRoutes {
    constructor(private readonly bulk: BulkService) {}

    @Post('bulk')
    @HttpCode(HttpStatus.OK)
    // A retry with the same key gets the first answer instead of acting twice.
    @RecordIdempotent(spec)
    @Can.Anyone() // Checked by BulkService: the action's permission, then each record.
    @ApiOperation({
      ...options.docs,
      // Kept from when the route was the feature's own (operationIdOf()).
      operationId: operationIdOf(spec, 'runBulk'),
    })
    @ApiOkResponse({ standardSchema: bulkResultSchema })
    @ApiAcceptedResponse({ standardSchema: bulkStartedSchema })
    @ApiBadRequestResponse({
      description:
        'The body is invalid (validation_failed: ids and filter both or neither, an unknown action, a bad filter or input), more than 500 ids (bulk_too_many), or the Idempotency-Key is missing.',
    })
    @ApiConflictResponse({
      description: 'A request with this Idempotency-Key is still running.',
    })
    @ApiUnprocessableEntityResponse({
      description: 'This Idempotency-Key was used for a different request.',
    })
    async runBulk(
      @CurrentUser() user: RequestPrincipal,
      @Body({ schema: options.body }) dto: Omit<BulkRequest, 'name' | 'ip'>,
      @Ip() ip: string,
      @Res({ passthrough: true }) res: Response,
    ) {
      const outcome = await this.bulk.run(user, {
        name: options.name,
        ...dto,
        ip,
      });
      if ('status' in outcome) {
        res.status(HttpStatus.ACCEPTED);
      }
      return outcome;
    }
  }
  return namedController(BulkRoutes, `${spec.className}BulkController`);
}
