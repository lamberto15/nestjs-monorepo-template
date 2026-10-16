import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
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
import type { Principal } from '../../iam/auth/principal.js';
import { bulkStatusSchema } from './bulk.schemas.js';
import { BulkService } from './bulk.service.js';

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
