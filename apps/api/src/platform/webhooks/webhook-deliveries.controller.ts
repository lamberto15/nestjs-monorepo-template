import { pageSchema } from '../../core/http/pagination.js';
import type { ListQuery } from '../../core/http/list-query.js';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import {
  CurrentClient,
  ClientOnly,
  type Client,
} from '../../iam/auth/client-only.decorator.js';
import {
  retriedSchema,
  retryDeliveriesSchema,
  webhookDeliverySchema,
  webhookDeliveryViewSchema,
  type RetryDeliveriesDto,
} from './webhook.schemas.js';
import { DELIVERY_LIST } from './webhook-store.view.js';
import { WebhookManagementService } from './webhook-management.service.js';

/** The list routes' description of their query (the delegated one says the same). */
export const DELIVERY_LIST_DESCRIPTION =
  'Newest first, paged by cursor (`limit`, `cursor` = the previous `nextCursor`). Filter flat (`?status=failed&endpointId=…&type.startsWith=note.&createdAt.gte=2026-01-01T00:00:00Z`) or with `filter` (and/or groups), sort with `sort=-attempts`, pick fields with `fields=status,type`; `count=true` adds `total`.';

/** An API client's delivery log: what was sent, how each attempt went, and a way to ask for it again. */
@ApiTags('webhooks')
@ApiBearerAuth('api-key')
@ApiUnauthorizedResponse({ description: 'Missing or unknown API key.' })
@Controller('webhook-deliveries')
@ClientOnly()
export class WebhookDeliveriesController {
  constructor(private readonly webhooks: WebhookManagementService) {}

  @Get()
  @ApiOperation({
    summary: 'The delivery log, newest first',
    description: DELIVERY_LIST_DESCRIPTION,
  })
  @ApiOkResponse({ standardSchema: pageSchema(webhookDeliverySchema) })
  list(
    @CurrentClient() client: Client,
    @Query({ schema: DELIVERY_LIST.schema }) query: ListQuery,
  ) {
    return this.webhooks.listDeliveries({ clientId: client.id }, query);
  }

  @Get(':id')
  @ApiOperation({
    summary:
      'One delivery, with the message sent, every attempt, their duration and the last request',
  })
  @ApiOkResponse({ standardSchema: webhookDeliveryViewSchema })
  @ApiNotFoundResponse()
  get(@CurrentClient() client: Client, @Param('id') id: string) {
    return this.webhooks.getDelivery({ clientId: client.id }, id);
  }

  @Post(':id/retry')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Send one delivery again, now',
    description:
      'Same webhook-id and body: a replay of a lost webhook, or a retry of a failed one.',
  })
  @ApiOkResponse({ standardSchema: retriedSchema })
  @ApiNotFoundResponse()
  retry(@CurrentClient() client: Client, @Param('id') id: string) {
    return this.webhooks.retry({ clientId: client.id }, id);
  }

  @Post('retry')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Retry every failed delivery since an outage began',
  })
  @ApiOkResponse({ standardSchema: retriedSchema })
  retryFailed(
    @CurrentClient() client: Client,
    @Body({ schema: retryDeliveriesSchema }) dto: RetryDeliveriesDto,
  ) {
    return this.webhooks.retryFailed({ clientId: client.id }, dto);
  }
}
