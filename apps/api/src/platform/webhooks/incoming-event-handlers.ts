import { Injectable } from '@nestjs/common';
import type { IncomingWebhook } from '@nestjs/webhooks';
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
 * The events tenants' senders may send, by `type`: a feature registers its
 * handler in its constructor (like a TagTarget). The receiver route runs it
 * in the sender's tenant; an unregistered type is acknowledged and ignored.
 */
@Injectable()
export class IncomingEventHandlers {
  private readonly handlers = new Map<string, IncomingEventHandler>();

  register(type: string, handler: IncomingEventHandler) {
    if (this.handlers.has(type)) {
      throw new Error(`An incoming event handler for "${type}" exists.`);
    }
    this.handlers.set(type, handler);
  }

  find(type: string) {
    return this.handlers.get(type);
  }
}
