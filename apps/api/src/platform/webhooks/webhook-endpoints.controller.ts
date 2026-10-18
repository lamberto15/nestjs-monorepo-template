import { listSchema } from '../../core/http/pagination.js';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
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
  webhookDeliverySchema,
  webhookEndpointSchema,
  type CreateEndpointDto,
  type UpdateEndpointDto,
} from './webhook.schemas.js';
import { WebhookManagementService } from './webhook-management.service.js';

/** What the test route says (the delegated one says the same). */
export const TEST_EVENT_DESCRIPTION =
  'Sends the reserved `webhook.test` event (`data`: `{ endpointId, test: true }`) to this endpoint alone, whatever it subscribed to, signed and retried as any webhook. Returns the delivery, pending: follow it at GET …/webhook-deliveries/{id}. A disabled endpoint gets no request (the delivery fails: endpoint-disabled).';

/** An API client's subscriptions. Every call is scoped to the client: another client's endpoint is a 404. */
@ApiTags('webhooks')
@ApiBearerAuth('api-key')
@ApiUnauthorizedResponse({ description: 'Missing or unknown API key.' })
@Controller('webhook-endpoints')
@ClientOnly()
export class WebhookEndpointsController {
  constructor(private readonly webhooks: WebhookManagementService) {}

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
    return this.webhooks.createEndpoint({ clientId: client.id }, dto);
  }

  @Get()
  @ApiOperation({ summary: "The client's endpoints" })
  @ApiOkResponse({ standardSchema: listSchema(webhookEndpointSchema) })
  list(@CurrentClient() client: Client) {
    return this.webhooks.listEndpoints({ clientId: client.id });
  }

  @Get(':id')
  @ApiOperation({ summary: 'One endpoint' })
  @ApiOkResponse({ standardSchema: webhookEndpointSchema })
  @ApiNotFoundResponse()
  get(@CurrentClient() client: Client, @Param('id') id: string) {
    return this.webhooks.getEndpoint({ clientId: client.id }, id);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Change an endpoint; only what is sent changes',
    description: '`description: null` clears it; an empty string is a 400.',
  })
  @ApiOkResponse({ standardSchema: webhookEndpointSchema })
  @ApiNotFoundResponse()
  update(
    @CurrentClient() client: Client,
    @Param('id') id: string,
    @Body({ schema: updateEndpointSchema }) dto: UpdateEndpointDto,
  ) {
    return this.webhooks.updateEndpoint({ clientId: client.id }, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Unsubscribe' })
  @ApiNoContentResponse()
  @ApiNotFoundResponse()
  async delete(@CurrentClient() client: Client, @Param('id') id: string) {
    await this.webhooks.deleteEndpoint({ clientId: client.id }, id);
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
  rotateSecret(@CurrentClient() client: Client, @Param('id') id: string) {
    return this.webhooks.rotateSecret({ clientId: client.id }, id);
  }

  @Post(':id/test')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Send a test event to the endpoint',
    description: TEST_EVENT_DESCRIPTION,
  })
  @ApiAcceptedResponse({ standardSchema: webhookDeliverySchema })
  @ApiNotFoundResponse()
  test(@CurrentClient() client: Client, @Param('id') id: string) {
    return this.webhooks.sendTest({ clientId: client.id }, id);
  }
}
