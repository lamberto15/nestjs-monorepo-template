import { Injectable, Logger } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import {
  HttpWebhookTransport,
  WebhooksStorage,
  WebhookTransport,
  type WebhookRequest,
  type WebhookTransportResponse,
  type WebhookTransportSendOptions,
} from '@nestjs/webhooks';
import type { Database } from '../../core/database/drizzle.js';
import { deliveryOptions } from './webhooks.config.js';
import {
  webhookDeliveryRequests,
  type SigningSecret,
} from './webhooks.tables.js';

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

  constructor(
    @InjectDrizzle() private readonly db: Database,
    private readonly storage: WebhooksStorage,
  ) {
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
    try {
      const row = {
        deliveryId: request.deliveryId,
        attempt,
        headers: { ...request.headers },
        sentAt: new Date(),
        signedWith: await this.signingSecrets(request),
      };
      await this.db
        .insert(webhookDeliveryRequests)
        .values(row)
        .onConflictDoUpdate({
          target: webhookDeliveryRequests.deliveryId,
          set: {
            attempt,
            headers: row.headers,
            sentAt: row.sentAt,
            signedWith: row.signedWith,
          },
        });
    } catch (error) {
      this.logger.warn(
        `Could not record the request of webhook delivery ${request.deliveryId}: ${(error as Error).message}`,
      );
    }
  }

  /**
   * The secrets that signed this request. Custom, an approximation: the
   * worker signs with every live secret of the endpoint (not expired, newest
   * first; an overlap after a rotation has two) and tells the transport
   * neither which nor their ids. So they are read again here: the endpoint's
   * live secrets, which are the same unless one expired or was rotated
   * between signing and now. They are matched to the signatures in the
   * header by count, in order; a count that differs (that race) records
   * nothing (null) rather than a guess. Only each secret's `createdAt` and
   * `expiresAt` are kept, never the secret.
   */
  private async signingSecrets(
    request: WebhookRequest,
  ): Promise<SigningSecret[] | null> {
    const endpoint = await this.storage.endpoints.getEndpoint(
      request.endpointId,
    );
    const now = Date.now();
    const live = (endpoint?.secrets ?? []).filter(
      (secret) => secret.expiresAt === null || secret.expiresAt > now,
    );
    const signatures = (request.headers['webhook-signature'] ?? '')
      .split(' ')
      .filter((entry) => entry.startsWith('v1,'));
    return live.length > 0 && live.length === signatures.length
      ? live.map(({ createdAt, expiresAt }) => ({ createdAt, expiresAt }))
      : null;
  }
}
