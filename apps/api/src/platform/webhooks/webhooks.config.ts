import type { WebhooksModuleOptions } from '@nestjs/webhooks';
import { runsWorkers } from '../../core/config/core.env.js';
import { NOTIFICATION_WEBHOOK_EVENT } from '../notifications/notification.types.js';
import { APPROVAL_EVENT_TYPES } from '../approvals/approval-events.js';
import type { PlatformOptions } from '../platform.options.js';
import { switchedOn } from '../switches.js';

/**
 * `WEBHOOKS_ALLOW_LOOPBACK=on` lets endpoints be http://127.0.0.1, for local
 * development and the tests. Off in production: only public https:// URLs.
 */
export const loopbackAllowed = () =>
  process.env.WEBHOOKS_ALLOW_LOOPBACK === 'on';

export function webhooksOptions(
  options: PlatformOptions,
  /** The incoming senders' secrets, by sender name. */
  secrets: Record<string, string>,
): WebhooksModuleOptions {
  const loopback = loopbackAllowed();
  return {
    // The types API clients may subscribe to; dispatch() refuses any other.
    // The platform's own: a notification to a client, as a webhook; approvals of its requests.
    eventTypes: [
      ...options.eventTypes,
      NOTIFICATION_WEBHOOK_EVENT,
      ...APPROVAL_EVENT_TYPES,
    ],
    // About two days of retries: growing from 5s to a 1h cap, then hourly.
    retry: {
      attempts: 50,
      backoff: { delay: '5s', factor: 4, maxDelay: '1h' },
    },
    // An endpoint that fails every attempt for five days is switched off.
    disableEndpointAfter: '5d',
    delivery: {
      timeout: '15s',
      // Private networks and cloud metadata stay blocked either way.
      allowHttp: loopback,
      allowedAddresses: loopback ? ['127.0.0.1/32'] : [],
    },
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
