import { Controller, Get } from '@nestjs/common';
import { Can } from '@nestjs/authorization';
import {
  ApiBearerAuth,
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { webhookEventTypesSchema } from './webhook.schemas.js';
import { WebhookManagementService } from './webhook-management.service.js';

/**
 * What an endpoint may subscribe to: metadata, for anyone signed in (a user
 * building a subscription screen, an API client choosing its types).
 */
@ApiTags('webhooks')
@ApiBearerAuth('api-key')
@ApiBearerAuth('user-token')
@ApiCookieAuth('user-session')
@ApiUnauthorizedResponse({ description: 'No valid API key or session.' })
@Controller('webhook-event-types')
export class WebhookEventTypesController {
  constructor(private readonly webhooks: WebhookManagementService) {}

  @Get()
  @Can.Anyone()
  @ApiOperation({
    summary: 'The event types an endpoint may subscribe to, by feature',
    description:
      'Declared by the features (`PlatformModule.forRoot({ eventTypes })`, a record\'s `events`) and the platform (notifications, approvals), each with its description when one is declared. `"*"` subscribes to all of them; any other type is a 400 on create. The reserved test event (`webhook.test`) is not among them.',
  })
  @ApiOkResponse({ standardSchema: webhookEventTypesSchema })
  list() {
    return this.webhooks.eventTypes();
  }
}
