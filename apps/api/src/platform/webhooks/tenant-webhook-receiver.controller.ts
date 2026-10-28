import {
  BadRequestException,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Public } from '@nestjs/authentication';
import {
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
  type SchemaObject,
} from '@nestjs/swagger';
import { IncomingWebhook, VerifyWebhook } from '@nestjs/webhooks';
import { z } from 'zod';
import { IncomingEventHandlers } from './incoming-event-handlers.js';
import {
  type IncomingEvent,
  incomingEventResultSchema,
  incomingEventSchema,
} from './incoming-sender.schemas.js';
import { TenantSenderGuard } from './tenant-sender.guard.js';
import { TENANT_SENDERS_RECEIVER } from './tenant-sender.scheme.js';

/**
 * Incoming webhooks of a tenant's own senders: the tenant is in the URL, and
 * the secret is the one that sender was registered with
 * (`/v1/webhook-senders`), so a call signed with another tenant's secret, or
 * for another tenant's sender, is a 401 like any bad signature. The work
 * runs in the sender's tenant; the event's `type` picks the handler a
 * feature registered (`IncomingEventHandlers`).
 */
@ApiTags('incoming webhooks')
@Public() // Signed by the sender and verified by @VerifyWebhook(): no sign-in.
@UseGuards(TenantSenderGuard) // Before the signature check: finds the sender and its tenant.
@Controller('webhooks/tenants/:tenantId/senders/:name')
export class TenantWebhookReceiverController {
  constructor(private readonly handlers: IncomingEventHandlers) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @VerifyWebhook(TENANT_SENDERS_RECEIVER)
  @ApiOperation({
    summary: "Receive an event from a tenant's sender",
    description:
      'Signed with Standard Webhooks (webhook-id, webhook-timestamp, webhook-signature) using the secret of the sender registered at POST /v1/webhook-senders. The body is `{ type, data }`. A redelivered webhook-id is answered 200 and not processed again.',
  })
  @ApiParam({ name: 'tenantId', format: 'uuid' })
  @ApiParam({
    name: 'name',
    description: 'The sender registered by this name.',
  })
  // The body is read from the raw bytes by @IncomingWebhook(), not @Body(): document it here.
  @ApiBody({
    schema: z.toJSONSchema(incomingEventSchema, {
      target: 'openapi-3.0',
    }) as SchemaObject,
  })
  @ApiOkResponse({ standardSchema: incomingEventResultSchema })
  @ApiUnauthorizedResponse({
    description:
      'Missing, invalid or stale signature, or no such enabled sender in that tenant (not told apart).',
  })
  async handle(
    // Verified by TenantSenderGuard: the sender exists in this tenant.
    @Param('tenantId') tenantId: string,
    @Param('name') name: string,
    @IncomingWebhook() webhook: IncomingWebhook<IncomingEvent>,
  ) {
    const parsed = incomingEventSchema.safeParse(webhook.payload);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'validation_failed',
        message: 'The request is invalid.',
        errors: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }
    const registered = this.handlers.find(parsed.data.type);
    if (!registered) {
      return { received: true as const, duplicate: false, handled: false };
    }
    const data = registered.definition.dataSchema.safeParse(parsed.data.data);
    if (!data.success) {
      throw new BadRequestException({
        code: 'validation_failed',
        message: 'The request is invalid.',
        errors: data.error.issues.map((issue) => ({
          path: ['data', ...issue.path].join('.'),
          message: issue.message,
        })),
      });
    }
    const result = await registered.handler({
      tenantId: tenantId.toLowerCase(),
      sender: name,
      webhook: webhook as IncomingWebhook<IncomingEvent>,
    });
    const duplicate =
      typeof result === 'object' &&
      result !== null &&
      (result as { duplicate?: unknown }).duplicate === true;
    return { received: true as const, duplicate, handled: true };
  }
}
