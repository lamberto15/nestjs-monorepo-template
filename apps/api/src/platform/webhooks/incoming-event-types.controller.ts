import { Controller, Get } from '@nestjs/common';
import { Can } from '@nestjs/authorization';
import {
  ApiBearerAuth,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AccessPolicy } from '../../iam/access/policies.js';
import { UserOnly } from '../../iam/auth/user-only.decorator.js';
import { IncomingEventHandlers } from './incoming-event-handlers.js';
import { incomingEventTypesSchema } from './incoming-sender.schemas.js';

/**
 * What a sender may send in: the **incoming** counterpart of
 * `GET /v1/webhook-event-types` (what an endpoint receives). For those who
 * register senders (`Access.manageClients`), since the types a deployment
 * handles are its own business. Listing a type grants nothing: the sender's
 * signature does, and the handler authorizes the work.
 */
@ApiTags('incoming webhooks', 'access')
@ApiCookieAuth('user-session')
@ApiBearerAuth('user-token')
@ApiUnauthorizedResponse({ description: 'No session (an API key is none).' })
@ApiForbiddenResponse({ description: 'Not allowed by your permissions.' })
@UserOnly()
@Can(AccessPolicy, 'manageClients')
@Controller('webhook-incoming-event-types')
export class IncomingEventTypesController {
  constructor(private readonly handlers: IncomingEventHandlers) {}

  @Get()
  @ApiOperation({
    summary: 'The event types a sender may send in, with their data schemas',
    description:
      'Incoming events only; the events an endpoint receives are `GET /v1/webhook-event-types`. Generated from the registered handlers, so it matches what the receiver validates. A listed type is not a permission. A type not listed is acknowledged and ignored (`handled: false`).',
  })
  @ApiOkResponse({ standardSchema: incomingEventTypesSchema })
  list() {
    return { items: this.handlers.catalog() };
  }
}
