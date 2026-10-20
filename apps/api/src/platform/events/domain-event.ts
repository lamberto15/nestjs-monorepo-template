import type { z } from 'zod';
import type {
  NotificationType,
  NotificationTypeDeclaration,
} from '../notifications/notification.types.js';
import type { WebhookEventTypeDeclaration } from '../platform.options.js';
import type { RealtimeEventDeclaration } from '../realtime/realtime-events.js';

/** What a domain event is called on its channels: the same name on each. */
interface DomainEventBase {
  /** `note.published`: full-stop delimited segments. */
  type: string;
  /**
   * An outgoing webhook event type API clients may subscribe to (`dispatch()`
   * refuses a type no event declares). `true`: the type alone; or its
   * description and the heading it is listed under.
   */
  webhook?: true | Omit<WebhookEventTypeDeclaration, 'type'>;
  /**
   * The realtime event of the same name, pushed with `Realtime.toPrincipal()`:
   * the payload's OpenAPI component id and schema. Published in
   * `x-realtime-events` and the typed client, checked in development and tests.
   */
  realtime?: { id: string; description: string; payload: z.ZodType };
}

/**
 * One domain event, declared once for the channels that carry it
 * (docs/webhooks-and-realtime.md, "Domain events"): `webhook` (outgoing
 * webhooks), `notification` (a notification type: its channels' defaults,
 * data and flags, texts in `i18n/<locale>/notifications.json`, so `type`
 * must name one) and `realtime`. A channel left out does not carry it.
 */
export type DomainEventDeclaration =
  | (DomainEventBase & {
      type: NotificationType;
      notification: Omit<NotificationTypeDeclaration<any>, 'type'>;
    })
  | (DomainEventBase & { notification?: undefined });

/** A feature's (or a record's) domain events, typed. */
export const defineDomainEvents = <
  const T extends readonly DomainEventDeclaration[],
>(
  events: T,
) => events;

/**
 * Splits domain events into what the platform's options take: webhook event
 * types, notification types and realtime events. In declaration order.
 * Custom code: nothing in NestJS joins these three; each stays the
 * platform's own declaration underneath.
 */
export function expandDomainEvents(events: readonly DomainEventDeclaration[]) {
  const eventTypes: WebhookEventTypeDeclaration[] = [];
  const notifications: NotificationTypeDeclaration<any>[] = [];
  const realtimeEvents: Record<string, RealtimeEventDeclaration> = {};
  for (const event of events) {
    if (event.webhook) {
      eventTypes.push({
        type: event.type,
        ...(event.webhook === true ? {} : event.webhook),
      });
    }
    if (event.notification) {
      notifications.push({ ...event.notification, type: event.type });
    }
    if (event.realtime) {
      if (event.type in realtimeEvents) {
        throw new Error(`Domain event "${event.type}" is declared twice.`);
      }
      realtimeEvents[event.type] = {
        description: event.realtime.description,
        payload: event.realtime.payload.meta({ id: event.realtime.id }),
      };
    }
  }
  return { eventTypes, notifications, realtimeEvents };
}
