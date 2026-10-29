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
  Put,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import { Idempotent } from '@nestjs/idempotency';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiCookieAuth,
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { ListQuery } from '../../core/http/list-query.js';
import { listSchema, pageSchema } from '../../core/http/pagination.js';
import { AccessPolicy } from '../../iam/access/policies.js';
import { RequiresSwitch } from '../../iam/auth/deployment-switch.js';
import type { UserPrincipal } from '../../iam/auth/principal.js';
import { RecentAuthentication } from '../../iam/auth/recent-authentication.js';
import { UserOnly } from '../../iam/auth/user-only.decorator.js';
import { idempotencyKeyHeader } from '../idempotency/idempotency.openapi.js';
import { DELIVERY_LIST_DESCRIPTION } from './webhook-deliveries.controller.js';
import { TEST_EVENT_DESCRIPTION } from './webhook-endpoints.controller.js';
import { WebhookManagementService } from './webhook-management.service.js';
import {
  createdWebhookEndpointSchema,
  createEndpointSchema,
  retriedSchema,
  retryDeliveriesSchema,
  rotatedSecretSchema,
  updateEndpointSchema,
  webhookDeliverySchema,
  webhookDeliveryViewSchema,
  webhookEndpointSchema,
  webhookScopeSchema,
  type CreateEndpointDto,
  type RetryDeliveriesDto,
  type UpdateEndpointDto,
  type WebhookScopeDto,
} from './webhook.schemas.js';
import { DELIVERY_LIST } from './webhook-store.view.js';

/**
 * An API client's webhooks, managed by a signed-in administrator on its
 * behalf: the same endpoints and deliveries as the client's own routes
 * (`/v1/webhook-endpoints`, `/v1/webhook-deliveries`), through the same
 * service with the client as the owner. Webhooks stay per API client
 * (docs/webhooks-and-realtime.md, "Managed by an administrator").
 *
 * Every route: a user (a session or a user token; an API key counts as no
 * credentials), `Access.manageClients` (never while impersonating:
 * AccessPolicy), a client of the caller's tenant (another tenant's is a
 * 404) on which the caller has authority (403 `authority_required`), and
 * API_CLIENTS on. Creating an endpoint and rotating its secret return a
 * secret: they want a recent sign-in. Changes are audited as the user's,
 * on the client.
 */
@ApiTags('webhooks', 'access')
@ApiCookieAuth('user-session')
@ApiBearerAuth('user-token')
@ApiUnauthorizedResponse({ description: 'No session (an API key is none).' })
@ApiForbiddenResponse({
  description:
    'Not allowed by your permissions, no authority over the client, or a step-up is due (reauthentication_required).',
})
@ApiNotFoundResponse({
  description: 'No such client in your tenant, endpoint or delivery.',
})
@ApiParam({ name: 'clientId', format: 'uuid' })
@UserOnly()
@RequiresSwitch('API_CLIENTS')
@Can(AccessPolicy, 'manageClients')
@Controller('access/clients/:clientId')
export class ClientWebhooksController {
  constructor(private readonly webhooks: WebhookManagementService) {}

  @Post('webhook-endpoints')
  @RecentAuthentication()
  @Idempotent({ required: false })
  @ApiOperation({
    summary: "Subscribe a URL to the client's events",
    description:
      'The secret is in the response, this once. Send an Idempotency-Key to retry safely.',
  })
  @ApiHeader(idempotencyKeyHeader(false))
  @ApiCreatedResponse({ standardSchema: createdWebhookEndpointSchema })
  @ApiBadRequestResponse({
    description:
      'A refused URL (not https, a private or cloud-metadata address) or an unknown event type.',
  })
  async create(
    @CurrentUser() user: UserPrincipal,
    @Param('clientId', ParseUUIDPipe) clientId: string,
    @Body({ schema: createEndpointSchema }) dto: CreateEndpointDto,
    @Ip() ip: string,
  ) {
    const owner = await this.webhooks.delegated(user, clientId, ip);
    return this.webhooks.createEndpoint(owner, dto);
  }

  @Get('webhook-endpoints')
  @ApiOperation({ summary: "The client's endpoints" })
  @ApiOkResponse({ standardSchema: listSchema(webhookEndpointSchema) })
  async list(
    @CurrentUser() user: UserPrincipal,
    @Param('clientId', ParseUUIDPipe) clientId: string,
  ) {
    return this.webhooks.listEndpoints(
      await this.webhooks.delegated(user, clientId),
    );
  }

  @Get('webhook-endpoints/:id')
  @ApiOperation({ summary: 'One of its endpoints' })
  @ApiOkResponse({ standardSchema: webhookEndpointSchema })
  async get(
    @CurrentUser() user: UserPrincipal,
    @Param('clientId', ParseUUIDPipe) clientId: string,
    @Param('id') id: string,
  ) {
    return this.webhooks.getEndpoint(
      await this.webhooks.delegated(user, clientId),
      id,
    );
  }

  @Patch('webhook-endpoints/:id')
  @ApiOperation({
    summary: 'Change an endpoint; only what is sent changes',
    description: '`description: null` clears it; an empty string is a 400.',
  })
  @ApiOkResponse({ standardSchema: webhookEndpointSchema })
  async update(
    @CurrentUser() user: UserPrincipal,
    @Param('clientId', ParseUUIDPipe) clientId: string,
    @Param('id') id: string,
    @Body({ schema: updateEndpointSchema }) dto: UpdateEndpointDto,
    @Ip() ip: string,
  ) {
    const owner = await this.webhooks.delegated(user, clientId, ip);
    return this.webhooks.updateEndpoint(owner, id, dto);
  }

  @Delete('webhook-endpoints/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Unsubscribe' })
  @ApiNoContentResponse()
  async delete(
    @CurrentUser() user: UserPrincipal,
    @Param('clientId', ParseUUIDPipe) clientId: string,
    @Param('id') id: string,
    @Ip() ip: string,
  ) {
    const owner = await this.webhooks.delegated(user, clientId, ip);
    await this.webhooks.deleteEndpoint(owner, id);
  }

  @Post('webhook-endpoints/:id/rotate-secret')
  @RecentAuthentication()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Rotate the endpoint's signing secret",
    description:
      'The new secret is in the response, this once; the old one keeps signing next to it for 24 hours.',
  })
  @ApiOkResponse({ standardSchema: rotatedSecretSchema })
  async rotateSecret(
    @CurrentUser() user: UserPrincipal,
    @Param('clientId', ParseUUIDPipe) clientId: string,
    @Param('id') id: string,
    @Ip() ip: string,
  ) {
    const owner = await this.webhooks.delegated(user, clientId, ip);
    return this.webhooks.rotateSecret(owner, id);
  }

  @Post('webhook-endpoints/:id/test')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Send a test event to the endpoint',
    description: TEST_EVENT_DESCRIPTION,
  })
  @ApiAcceptedResponse({ standardSchema: webhookDeliverySchema })
  async test(
    @CurrentUser() user: UserPrincipal,
    @Param('clientId', ParseUUIDPipe) clientId: string,
    @Param('id') id: string,
    @Ip() ip: string,
  ) {
    const owner = await this.webhooks.delegated(user, clientId, ip);
    return this.webhooks.sendTest(owner, id);
  }

  @Get('webhook-deliveries')
  @ApiOperation({
    summary: "The client's delivery log, newest first",
    description: DELIVERY_LIST_DESCRIPTION,
  })
  @ApiOkResponse({ standardSchema: pageSchema(webhookDeliverySchema) })
  async deliveries(
    @CurrentUser() user: UserPrincipal,
    @Param('clientId', ParseUUIDPipe) clientId: string,
    @Query({ schema: DELIVERY_LIST.schema }) query: ListQuery,
  ) {
    return this.webhooks.listDeliveries(
      await this.webhooks.delegated(user, clientId),
      query,
    );
  }

  @Get('webhook-deliveries/:id')
  @ApiOperation({
    summary:
      'One delivery, with the message sent, every attempt, their duration and the last request',
  })
  @ApiOkResponse({ standardSchema: webhookDeliveryViewSchema })
  async delivery(
    @CurrentUser() user: UserPrincipal,
    @Param('clientId', ParseUUIDPipe) clientId: string,
    @Param('id') id: string,
  ) {
    return this.webhooks.getDelivery(
      await this.webhooks.delegated(user, clientId),
      id,
    );
  }

  @Post('webhook-deliveries/:id/retry')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Send one delivery again, now',
    description: 'Same webhook-id and body.',
  })
  @ApiOkResponse({ standardSchema: retriedSchema })
  async retry(
    @CurrentUser() user: UserPrincipal,
    @Param('clientId', ParseUUIDPipe) clientId: string,
    @Param('id') id: string,
    @Ip() ip: string,
  ) {
    const owner = await this.webhooks.delegated(user, clientId, ip);
    return this.webhooks.retry(owner, id);
  }

  @Post('webhook-deliveries/retry')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Retry every failed delivery since an outage began',
  })
  @ApiOkResponse({ standardSchema: retriedSchema })
  async retryFailed(
    @CurrentUser() user: UserPrincipal,
    @Param('clientId', ParseUUIDPipe) clientId: string,
    @Body({ schema: retryDeliveriesSchema }) dto: RetryDeliveriesDto,
    @Ip() ip: string,
  ) {
    const owner = await this.webhooks.delegated(user, clientId, ip);
    return this.webhooks.retryFailed(owner, dto);
  }

  @Get('webhook-scope')
  @ApiOperation({
    summary: "Which records' events the client's endpoints receive",
  })
  @ApiOkResponse({ standardSchema: webhookScopeSchema })
  async scope(
    @CurrentUser() user: UserPrincipal,
    @Param('clientId', ParseUUIDPipe) clientId: string,
  ) {
    return this.webhooks.getScope(
      await this.webhooks.delegated(user, clientId),
    );
  }

  @Put('webhook-scope')
  @RecentAuthentication()
  @ApiOperation({
    summary: "Set which records' events the client's endpoints receive",
    description:
      "`tenant` also sends events about the tenant's records owned by users and other clients, each only when the client may read that record, redacted to the fields it may read; `own` (the default) only the client's own. Wants a recent sign-in: it widens what leaves the tenant.",
  })
  @ApiOkResponse({ standardSchema: webhookScopeSchema })
  async setScope(
    @CurrentUser() user: UserPrincipal,
    @Param('clientId', ParseUUIDPipe) clientId: string,
    @Body({ schema: webhookScopeSchema }) dto: WebhookScopeDto,
    @Ip() ip: string,
  ) {
    const owner = await this.webhooks.delegated(user, clientId, ip);
    return this.webhooks.setScope(owner, dto.scope);
  }
}
