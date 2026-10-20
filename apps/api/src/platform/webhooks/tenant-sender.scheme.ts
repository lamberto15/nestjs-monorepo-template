import { WebhookSignatureScheme } from '@nestjs/webhooks';
import type {
  WebhookSignatureCheck,
  WebhookSignedRequest,
} from '@nestjs/webhooks';
import { createHmac } from 'node:crypto';
import { ClsServiceManager } from 'nestjs-cls';

/** The receiver's name in `WebhooksModule` `receivers` (`@VerifyWebhook()`). */
export const TENANT_SENDERS_RECEIVER = 'tenant-senders';

/** The sender a request is verified against, set by TenantSenderGuard in the request's CLS context. */
export const TENANT_SENDER = Symbol('tenant-webhooks.sender');

export interface ResolvedSender {
  id: string;
  tenantId: string;
  name: string;
  /** The secrets that verify now: the current one, and the previous while it lasts. */
  secrets: readonly string[];
}

const TIMESTAMP = /^\d{1,12}$/;
/** The package refuses longer inbox keys; ours adds the sender's id (36) and a colon. */
const MAX_WEBHOOK_ID = 200;

const invalid = (
  reason: 'missing-header' | 'malformed-header' | 'invalid-signature',
  detail: string,
): WebhookSignatureCheck => ({ valid: false, reason, detail });

const one = (value: string | string[] | undefined) =>
  Array.isArray(value) ? (value.length === 1 ? value[0] : null) : value;

/** The key of a `whsec_…` secret: the base64 after the prefix (Standard Webhooks). */
const keyOf = (secret: string) =>
  Buffer.from(secret.replace(/^whsec_/, ''), 'base64');

/**
 * Standard Webhooks (`webhook-id`, `webhook-timestamp`, `webhook-signature:
 * v1,…`) for the secrets of the sender the route names, which differ per
 * tenant and are known only per request, not at startup.
 *
 * Custom code: @nestjs/webhooks' receivers take fixed secrets from its
 * configuration, and its Standard Webhooks scheme is not exported. This
 * scheme plugs into the same receiver machinery (the timestamp tolerance,
 * the inbox that skips a redelivered id, `processInTransaction()`) and reads
 * the sender's secrets from the request's context instead of from `keys`
 * (which is a placeholder). Signatures compare in constant time
 * (`WebhookSignatureScheme.matches`). The inbox key carries the sender's id,
 * so two tenants' senders never share a webhook id.
 */
export class TenantSenderScheme extends WebhookSignatureScheme {
  override verify(request: WebhookSignedRequest): WebhookSignatureCheck {
    const sender = ClsServiceManager.getClsService().get(TENANT_SENDER) as
      ResolvedSender | undefined;
    if (!sender) {
      return invalid('invalid-signature', 'no sender resolved for the route');
    }
    const { headers, rawBody } = request;
    const id = one(headers['webhook-id']);
    const timestamp = one(headers['webhook-timestamp']);
    const signature = one(headers['webhook-signature']);
    if (!id || !timestamp || !signature) {
      return invalid(
        'missing-header',
        'a webhook- header is missing or repeated',
      );
    }
    if (id.length > MAX_WEBHOOK_ID || !TIMESTAMP.test(timestamp)) {
      return invalid('malformed-header', 'webhook-id or webhook-timestamp');
    }
    const candidates = signature
      .split(' ')
      .filter((entry) => entry.startsWith('v1,'))
      .map((entry) => Buffer.from(entry.slice(3), 'base64'));
    let valid = false;
    for (const secret of sender.secrets) {
      const expected = createHmac('sha256', keyOf(secret))
        .update(`${id}.${timestamp}.`)
        .update(rawBody)
        .digest();
      valid = WebhookSignatureScheme.matches(expected, candidates) || valid;
    }
    return valid
      ? { valid: true, id: `${sender.id}:${id}`, timestamp: Number(timestamp) }
      : invalid('invalid-signature', 'no signature matches the sender');
  }
}
