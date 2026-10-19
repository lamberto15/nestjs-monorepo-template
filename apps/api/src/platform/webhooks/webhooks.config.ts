import type {
  WebhookDeliveryOptions,
  WebhooksModuleOptions,
} from '@nestjs/webhooks';
import { runsWorkers } from '../../core/config/core.env.js';
import { NOTIFICATION_WEBHOOK_EVENT } from '../notifications/notification.types.js';
import { APPROVAL_EVENT_TYPES } from '../approvals/approval-events.js';
import type {
  PlatformOptions,
  WebhookEventTypeDeclaration,
} from '../platform.options.js';
import { switchedOn } from '../switches.js';

/**
 * `WEBHOOKS_ALLOW_LOOPBACK=on` lets endpoints be http://127.0.0.1, for local
 * development and the tests. Off in production: only public https:// URLs.
 */
export const loopbackAllowed = () =>
  process.env.WEBHOOKS_ALLOW_LOOPBACK === 'on';

/**
 * The test event (`POST …/webhook-endpoints/{id}/test`): reserved. It is
 * not among the types an endpoint may subscribe to (creating one with it is
 * a 400, as any unknown type), nor in the catalog; it reaches only the
 * endpoint it was sent to, whatever that endpoint subscribed to.
 */
export const TEST_EVENT_TYPE = 'webhook.test';

/** An event type as GET /v1/webhook-event-types lists it. */
export interface WebhookEventTypeView {
  type: string;
  description: string | null;
}

/**
 * Every event type API clients may subscribe to, declared: the features'
 * (`PlatformModule.forRoot({ eventTypes })`, a record's `events`), then the
 * platform's own (a notification to a client, as a webhook; approvals of
 * its requests). In declaration order, each once.
 */
export function declaredEventTypes(
  options: Pick<PlatformOptions, 'eventTypes'>,
): Required<WebhookEventTypeDeclaration>[] {
  const declared: (string | WebhookEventTypeDeclaration)[] = [
    ...options.eventTypes,
    {
      type: NOTIFICATION_WEBHOOK_EVENT,
      description: 'A notification to the API client (docs/notifications.md).',
    },
    ...APPROVAL_EVENT_TYPES.map((type) => ({
      type,
      description: `An approval request of the API client's: ${type.slice('approval.'.length).replace('-', ' ')}.`,
    })),
  ];
  const byType = new Map<string, Required<WebhookEventTypeDeclaration>>();
  for (const item of declared) {
    const { type, description, group } =
      typeof item === 'string' ? { type: item } : item;
    if (!byType.has(type)) {
      byType.set(type, {
        type,
        description: description ?? '',
        group: group ?? type.split('.')[0]!,
      });
    }
  }
  return [...byType.values()];
}

/** The event types grouped (by feature: a type's group, its first segment by default), in declaration order. */
export function eventTypeGroups(options: Pick<PlatformOptions, 'eventTypes'>) {
  const groups = new Map<string, WebhookEventTypeView[]>();
  for (const { type, description, group } of declaredEventTypes(options)) {
    const types = groups.get(group) ?? [];
    types.push({ type, description: description || null });
    groups.set(group, types);
  }
  return [...groups].map(([group, types]) => ({ group, types }));
}

/**
 * How deliveries are sent: the package's `delivery` options, which the
 * recording transport's HTTP transport takes too (recording.transport.ts).
 * Private networks and cloud metadata stay blocked either way.
 */
export function deliveryOptions(): WebhookDeliveryOptions {
  const loopback = loopbackAllowed();
  return {
    timeout: '15s',
    allowHttp: loopback,
    allowedAddresses: loopback ? ['127.0.0.1/32'] : [],
  };
}

export function webhooksOptions(
  options: PlatformOptions,
  /** The incoming senders' secrets, by sender name. */
  secrets: Record<string, string>,
): WebhooksModuleOptions {
  return {
    // The types API clients may subscribe to; dispatch() refuses any other.
    eventTypes: declaredEventTypes(options).map(({ type }) => type),
    // Up to about 44 hours of retries (docs/webhooks-and-realtime.md): waits grow from 5s to a 1h cap, then hourly.
    retry: {
      attempts: 50,
      backoff: { delay: '5s', factor: 4, maxDelay: '1h' },
    },
    // An endpoint that fails every attempt for five days is switched off.
    disableEndpointAfter: '5d',
    delivery: deliveryOptions(),
    worker: {
      enabled:
        switchedOn('WEBHOOKS') &&
        process.env.WEBHOOKS_WORKER !== 'off' &&
        runsWorkers(),
      pollInterval: '1s',
    },
    // Endpoint secrets at rest: the first key encrypts, every key decrypts.
    encryption: process.env.WEBHOOKS_ENCRYPTION_KEYS
      ? {
          keys: process.env.WEBHOOKS_ENCRYPTION_KEYS.split(',').map((key) =>
            key.trim(),
          ),
        }
      : undefined,
    // The senders whose webhooks this API accepts, by the name @VerifyWebhook() uses.
    receivers: Object.fromEntries(
      (options.incomingWebhooks ?? []).map((sender) => [
        sender.name,
        {
          scheme: sender.scheme,
          ...(sender.header && { header: sender.header }),
          secret: secrets[sender.name],
        },
      ]),
    ),
  };
}
