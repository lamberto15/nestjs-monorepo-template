import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import {
  ApiBearerAuth,
  ApiCookieAuth,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { ListQuery } from '../../core/http/list-query.js';
import { pageSchema } from '../../core/http/pagination.js';
import type { Principal } from '../../iam/auth/principal.js';
import { SUBSCRIPTION_LIST } from './subscription.list.js';
import { subscriptionSchema } from './subscription.schemas.js';
import { SubscriptionsService } from './subscriptions.service.js';

/**
 * What the caller watches. Watching starts on the record's own route
 * (`POST /notes/{id}/watch`: the feature checks they may read it); here
 * they see and end their subscriptions.
 */
@ApiTags('subscriptions')
@ApiBearerAuth('api-key')
@ApiBearerAuth('user-token')
@ApiCookieAuth('user-session')
@ApiUnauthorizedResponse({ description: 'No valid API key or session.' })
@Controller('subscriptions')
export class SubscriptionsController {
  constructor(private readonly subscriptions: SubscriptionsService) {}

  @Get()
  @Can.Anyone()
  @ApiOperation({
    summary: 'The records you watch',
    description: 'Filter with `?subject=Note`; newest first; cursor pages.',
  })
  @ApiOkResponse({ standardSchema: pageSchema(subscriptionSchema) })
  async list(
    @CurrentUser() user: Principal,
    @Query({ schema: SUBSCRIPTION_LIST.schema }) query: ListQuery,
  ) {
    return SUBSCRIPTION_LIST.pick(
      await this.subscriptions.page(user, query),
      query,
    );
  }

  @Delete(':subject/:recordId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Can.Anyone()
  @ApiOperation({ summary: 'Stop watching a record' })
  @ApiNoContentResponse()
  @ApiNotFoundResponse({ description: 'You were not watching it.' })
  async remove(
    @CurrentUser() user: Principal,
    @Param('subject') subject: string,
    @Param('recordId') recordId: string,
  ) {
    await this.subscriptions.remove(user, { subject, recordId });
  }
}
