import { listSchema } from '../../core/http/pagination.js';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
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
import { WebhookDeliveries } from '@nestjs/webhooks';
import {
  CurrentClient,
  ClientOnly,
  type Client,
} from '../../iam/auth/client-only.decorator.js';
import {
  listDeliveriesQuerySchema,
  retriedSchema,
  retryDeliveriesSchema,
  webhookDeliveryDetailsSchema,
  webhookDeliverySchema,
  type ListDeliveriesQuery,
  type RetryDeliveriesDto,
} from './webhook.schemas.js';

/** An API client's delivery log: what was sent, how each attempt went, and a way to ask for it again. */
@ApiTags('webhooks')
@ApiBearerAuth('api-key')
@ApiUnauthorizedResponse({ description: 'Missing or unknown API key.' })
@Controller('webhook-deliveries')
@ClientOnly()
export class WebhookDeliveriesController {
  constructor(private readonly webhookDeliveries: WebhookDeliveries) {}

  @Get()
  @ApiOperation({ summary: 'The delivery log, newest first' })
  @ApiOkResponse({ standardSchema: listSchema(webhookDeliverySchema) })
  async list(
    @CurrentClient() client: Client,
    @Query({ schema: listDeliveriesQuerySchema }) query: ListDeliveriesQuery,
  ) {
    return {
      items: await this.webhookDeliveries.list({ tenant: client.id, ...query }),
    };
  }

  @Get(':id')
  @ApiOperation({
    summary: 'One delivery, with the message sent and every attempt',
  })
  @ApiOkResponse({ standardSchema: webhookDeliveryDetailsSchema })
  @ApiNotFoundResponse()
  async get(@CurrentClient() client: Client, @Param('id') id: string) {
    const delivery = await this.webhookDeliveries.get(id, {
      tenant: client.id,
    });
    if (!delivery) {
      throw new NotFoundException(`Webhook delivery ${id} not found`);
    }
    return delivery;
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
  async retry(@CurrentClient() client: Client, @Param('id') id: string) {
    return {
      retried: await this.webhookDeliveries.retry(id, { tenant: client.id }),
    };
  }

  @Post('retry')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Retry every failed delivery since an outage began',
  })
  @ApiOkResponse({ standardSchema: retriedSchema })
  async retryFailed(
    @CurrentClient() client: Client,
    @Body({ schema: retryDeliveriesSchema }) dto: RetryDeliveriesDto,
  ) {
    const since = dto.since === undefined ? undefined : new Date(dto.since);
    const retried = await this.webhookDeliveries.retry(
      { endpointId: dto.endpointId, status: 'failed', since },
      { tenant: client.id },
    );
    return { retried };
  }
}
