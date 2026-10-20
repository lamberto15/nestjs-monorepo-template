import webpush from 'web-push';
import type { DevicePlatform } from '../messaging.tables.js';
import {
  PushSendError,
  type PushPayload,
  type PushProvider,
} from './push-provider.js';

export interface WebPushOptions {
  subject: string;
  publicKey: string;
  privateKey: string;
}

/**
 * Web Push with VAPID (the `web-push` library: RFC 8030/8291 payload
 * encryption is not something to hand-write). A device's token is its
 * `PushSubscription` as JSON. iOS and Android push (APNs, FCM) are further
 * providers behind the same interface (docs/notifications.md).
 */
export class WebPushProvider implements PushProvider {
  readonly name = 'web-push';
  readonly platforms: readonly DevicePlatform[] = ['web'];

  constructor(private readonly options: WebPushOptions) {}

  async send(token: string, payload: PushPayload) {
    let subscription: webpush.PushSubscription;
    try {
      subscription = JSON.parse(token) as webpush.PushSubscription;
    } catch {
      return 'gone' as const;
    }
    try {
      await webpush.sendNotification(subscription, JSON.stringify(payload), {
        vapidDetails: {
          subject: this.options.subject,
          publicKey: this.options.publicKey,
          privateKey: this.options.privateKey,
        },
        TTL: 24 * 3600,
        timeout: 10_000,
      });
      return 'sent' as const;
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) {
        return 'gone' as const; // the subscription expired or was unsubscribed
      }
      const transient = status === undefined || status === 429 || status >= 500;
      throw new PushSendError(
        `Web push failed${status ? ` (${status})` : ''}`,
        !transient,
      );
    }
  }
}
