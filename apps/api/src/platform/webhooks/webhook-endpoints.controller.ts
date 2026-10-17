import { listSchema } from '../../core/http/pagination.js';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiHeader,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Idempotent } from '@nestjs/idempotency';
import { WebhookEndpoints } from '@nestjs/webhooks';
import { idempotencyKeyHeader } from '../idempotency/idempotency.openapi.js';
import {
  CurrentClient,
  ClientOnly,
  type Client,
} from '../../iam/auth/client-only.decorator.js';
import {
  createdWebhookEndpointSchema,
  createEndpointSchema,
  rotatedSecretSchema,
  updateEndpointSchema,
  webhookEndpointSchema,
  type CreateEndpointDto,
  type UpdateEndpointDto,
} from './webhook.schemas.js';

/** An API client's subscriptions. Every call is scoped to the client: another client's endpoint is a 404. */
@ApiTags('webhooks')
@ApiBearerAuth('api-key')
@ApiUnauthorizedResponse({ description: 'Missing or unknown API key.' })
@Controller('webhook-endpoints')
@ClientOnly()
export class WebhookEndpointsController {
  constructor(private readonly webhookEndpoints: WebhookEndpoints) {}

  /** Returns the endpoint and its secret. The secret is shown this once. */
  @Post()
  // A retried subscribe gets the first endpoint (and its secret) back instead of
  // a second endpoint that would receive every webhook twice. Optional, so the
  // API stays easy to try (whatever IDEMPOTENCY says); the stored response is encrypted.
  @Idempotent({ required: false })
  @ApiOperation({
    summary: 'Subscribe a URL to events',
    description:
      'Send an Idempotency-Key to retry safely: a retry with the same key returns the same endpoint instead of creating a second one.',
  })
  @ApiHeader(idempotencyKeyHeader(false))
  @ApiCreatedResponse({ standardSchema: createdWebhookEndpointSchema })
  @ApiBadRequestResponse({
    description:
      'A refused URL (not https, a private or cloud-metadata address) or an unknown event type.',
  })
  create(
    @CurrentClient() client: Client,
    @Body({ schema: createEndpointSchema }) dto: CreateEndpointDto,
  ) {
    return this.webhookEndpoints.create({
      url: dto.url,
      eventTypes: dto.eventTypes,
      description: dto.description ?? null,
      tenant: client.id,
    });
  }

  @Get()
  @ApiOperation({ summary: "The client's endpoints" })
  @ApiOkResponse({ standardSchema: listSchema(webhookEndpointSchema) })
  async list(@CurrentClient() client: Client) {
    return { items: await this.webhookEndpoints.list({ tenant: client.id }) };
  }

  @Get(':id')
  @ApiOperation({ summary: 'One endpoint' })
  @ApiOkResponse({ standardSchema: webhookEndpointSchema })
  @ApiNotFoundResponse()
  async get(@CurrentClient() client: Client, @Param('id') id: string) {
    const endpoint = await this.webhookEndpoints.get(id, {
      tenant: client.id,
    });
    if (!endpoint) {
      throw new NotFoundException(`Webhook endpoint ${id} not found`);
    }
    return endpoint;
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Change an endpoint; only what is sent changes' })
  @ApiOkResponse({ standardSchema: webhookEndpointSchema })
  @ApiNotFoundResponse()
  update(
    @CurrentClient() client: Client,
    @Param('id') id: string,
    @Body({ schema: updateEndpointSchema }) dto: UpdateEndpointDto,
  ) {
    return this.webhookEndpoints.update(id, dto, { tenant: client.id });
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Unsubscribe' })
  @ApiNoContentResponse()
  @ApiNotFoundResponse()
  async delete(@CurrentClient() client: Client, @Param('id') id: string) {
    await this.webhookEndpoints.delete(id, { tenant: client.id });
  }

  /** A new secret. The old one keeps signing for 24 hours, so the client can switch without a gap. */
  @Post(':id/rotate-secret')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Rotate the endpoint's signing secret",
    description:
      'The old secret keeps signing next to the new one for 24 hours.',
  })
  @ApiOkResponse({ standardSchema: rotatedSecretSchema })
  @ApiNotFoundResponse()
  async rotateSecret(@CurrentClient() client: Client, @Param('id') id: string) {
    return {
      secret: await this.webhookEndpoints.rotateSecret(id, {
        tenant: client.id,
      }),
    };
  }
}
