import { Injectable } from '@nestjs/common';
import type { IncomingWebhook } from '@nestjs/webhooks';
import { z } from 'zod';
import type { IncomingEvent } from './incoming-sender.schemas.js';

/** What a handler is given: the verified event, and who sent it. */
export interface IncomingEventContext {
  /** The sender's tenant: the work already runs in it (docs/tenancy.md). */
  tenantId: string;
  /** The sender's name in that tenant. */
  sender: string;
  /** Verified; `processInTransaction()` records its id for exactly-once effects. */
  webhook: IncomingWebhook<IncomingEvent>;
}

export type IncomingEventHandler = (
  context: IncomingEventContext,
) => Promise<unknown>;

/**
 * What an incoming event type is, declared once with its handler: the receiver
 * validates `data` with `dataSchema`, and the catalog
 * (`GET /v1/webhook-incoming-event-types`) is generated from it, so neither
 * can drift from the handler.
 */
export interface IncomingEventDefinition {
  description: string;
  /** The shape of the envelope's `data`; a body that does not match is a 400. */
  dataSchema: z.ZodType;
  /** A safe `data` for the docs; it must satisfy `dataSchema`. */
  example: unknown;
  /** What the sender may rely on: deduplication and acknowledgement. */
  delivery: string;
}

/**
 * The events tenants' senders may send, by `type`: a feature registers its
 * handler in its constructor (like a TagTarget). The receiver route runs it
 * in the sender's tenant; an unregistered type is acknowledged and ignored.
 * A type in this registry is documented, not permitted: who may send is the
 * sender's signature, and the handler authorizes the work itself.
 */
@Injectable()
export class IncomingEventHandlers {
  private readonly handlers = new Map<
    string,
    { handler: IncomingEventHandler; definition: IncomingEventDefinition }
  >();

  register(
    type: string,
    definition: IncomingEventDefinition,
    handler: IncomingEventHandler,
  ) {
    if (this.handlers.has(type)) {
      throw new Error(`An incoming event handler for "${type}" exists.`);
    }
    this.handlers.set(type, { handler, definition });
  }

  find(type: string) {
    return this.handlers.get(type);
  }

  /** The registered types, documented, by type. */
  catalog() {
    return [...this.handlers]
      .map(([type, { definition }]) => ({
        type,
        description: definition.description,
        dataSchema: z.toJSONSchema(definition.dataSchema, {
          target: 'openapi-3.0',
        }) as Record<string, unknown>,
        example: { type, data: definition.example },
        delivery: definition.delivery,
      }))
      .sort((a, b) => a.type.localeCompare(b.type));
  }
}
