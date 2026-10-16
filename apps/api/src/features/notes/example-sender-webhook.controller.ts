import { Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { Public } from '@nestjs/authentication';
import {
  ApiBody,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
  type SchemaObject,
} from '@nestjs/swagger';
import { IncomingWebhook, VerifyWebhook } from '@nestjs/webhooks';
import { z } from 'zod';
import type { IncomingWebhookSender } from '../../platform/platform.options.js';
import { NotesService } from './notes.service.js';

/** The sender, as PlatformModule.forRoot() takes it (AppModule): Standard Webhooks, secret in the environment. */
export const EXAMPLE_SENDER: IncomingWebhookSender = {
  name: 'example-sender',
  scheme: 'standard',
  secretEnv: 'EXAMPLE_SENDER_WEBHOOK_SECRET',
};

/** What the example sender POSTs (Standard Webhooks: the event id is the `webhook-id` header). */
export const exampleSenderEventSchema = z.object({
  type: z.literal('note.publish-requested'),
  // The tenant the note is in: the route is public, so the event names it
  // (docs/tenancy.md); a note of another tenant is a 404.
  data: z.object({ noteId: z.string(), tenantId: z.uuid() }),
});
type ExampleSenderEvent = z.infer<typeof exampleSenderEventSchema>;

const resultSchema = z.object({
  received: z.literal(true),
  duplicate: z.boolean(),
});

/**
 * An incoming webhook, verified and processed exactly once: the pattern for
 * any third party that calls you (payments, carriers, CRMs). Configure the
 * sender like EXAMPLE_SENDER above (PlatformModule.forRoot), then copy this controller.
 */
@ApiTags('incoming webhooks')
@Public() // Signed by the sender and verified by @VerifyWebhook(): no sign-in.
@Controller('webhooks/example-sender')
export class ExampleSenderWebhookController {
  constructor(private readonly notes: NotesService) {}

  /**
   * Verified on the raw body before the handler runs (a bad or stale
   * signature is a 401). The inbox record and the change commit together, so
   * a redelivered event id changes nothing.
   */
  @Post()
  @HttpCode(HttpStatus.OK)
  @VerifyWebhook(EXAMPLE_SENDER.name)
  @ApiOperation({
    summary: 'Ask for a note to be published now',
    description:
      'Signed with Standard Webhooks (webhook-id, webhook-timestamp, webhook-signature) using EXAMPLE_SENDER_WEBHOOK_SECRET.',
  })
  // The body is read from the raw bytes by @IncomingWebhook(), not @Body(): document it here.
  @ApiBody({
    schema: z.toJSONSchema(exampleSenderEventSchema, {
      target: 'openapi-3.0',
    }) as SchemaObject,
  })
  @ApiOkResponse({ standardSchema: resultSchema })
  @ApiUnauthorizedResponse({
    description: 'Missing, invalid or stale signature.',
  })
  @ApiNotFoundResponse({
    description:
      'Unknown note: nothing recorded, so a retry is processed later.',
  })
  async handle(
    @IncomingWebhook() webhook: IncomingWebhook<ExampleSenderEvent>,
  ) {
    const result = await this.notes.publishFromWebhook(webhook);
    return { received: true, duplicate: result.duplicate };
  }
}
