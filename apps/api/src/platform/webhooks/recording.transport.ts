import { Injectable, Logger } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import {
  HttpWebhookTransport,
  WebhookTransport,
  type WebhookRequest,
  type WebhookTransportResponse,
  type WebhookTransportSendOptions,
} from '@nestjs/webhooks';
import type { Database } from '../../core/database/drizzle.js';
import { deliveryOptions } from './webhooks.config.js';
import { webhookDeliveryRequests } from './webhooks.tables.js';

/**
 * The package's SSRF-guarded HTTP transport, built from the same `delivery`
 * options, which first records the request it is about to send (its
 * headers, never a secret: the signature is an HMAC of the body) for the
 * delivery log (`GET …/webhook-deliveries/{id}`, `lastRequest`).
 *
 * Custom: @nestjs/webhooks logs each attempt's status, duration and
 * response but not its request; a transport is the documented place to
 * wrap sending ("Transports"), and the worker's own signing, timeout and
 * retries stay the package's. A failed write is logged and the webhook is
 * sent anyway: the log is a convenience, the delivery is not.
 */
@Injectable()
export class RecordingWebhookTransport extends WebhookTransport {
  private readonly logger = new Logger(RecordingWebhookTransport.name);
  private readonly http = new HttpWebhookTransport(deliveryOptions());

  constructor(@InjectDrizzle() private readonly db: Database) {
    super();
  }

  async send(
    request: WebhookRequest,
    options: WebhookTransportSendOptions,
  ): Promise<WebhookTransportResponse> {
    await this.record(request, options.attempt);
    return this.http.send(request, options);
  }

  private async record(request: WebhookRequest, attempt: number) {
    const row = {
      deliveryId: request.deliveryId,
      attempt,
      headers: { ...request.headers },
      sentAt: new Date(),
    };
    try {
      await this.db
        .insert(webhookDeliveryRequests)
        .values(row)
        .onConflictDoUpdate({
          target: webhookDeliveryRequests.deliveryId,
          set: { attempt, headers: row.headers, sentAt: row.sentAt },
        });
    } catch (error) {
      this.logger.warn(
        `Could not record the request of webhook delivery ${request.deliveryId}: ${(error as Error).message}`,
      );
    }
  }
}
