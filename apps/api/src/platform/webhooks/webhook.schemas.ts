import { z } from 'zod';
import { WEBHOOK_SCOPES } from './webhooks.tables.js';

const eventTypes = z
  .array(z.string())
  .describe(
    'Event types to receive (GET /v1/webhook-event-types), or "*" for all. An unknown type is a 400; so is the reserved webhook.test.',
  );

/** Body of `POST /webhook-endpoints`. The package checks the URL and the types themselves. */
export const createEndpointSchema = z.object({
  url: z
    .string()
    .describe(
      'A public https:// URL. Private and cloud-metadata addresses are refused.',
    ),
  eventTypes,
  // Not empty: no description is its absence (or null on PATCH), never "".
  description: z.string().min(1).optional(),
});
export type CreateEndpointDto = z.infer<typeof createEndpointSchema>;

/** Body of `PATCH /webhook-endpoints/:id`: only what is sent changes. */
export const updateEndpointSchema = z.object({
  url: z.string().optional(),
  eventTypes: eventTypes.optional(),
  description: z
    .string()
    .min(1)
    .nullable()
    .optional()
    .describe(
      'null clears it (an empty string is refused: 400); absent leaves it as it is.',
    ),
  enabled: z.boolean().optional(),
});
export type UpdateEndpointDto = z.infer<typeof updateEndpointSchema>;

/** Body of `POST /webhook-deliveries/retry`: every failed delivery since an outage began. */
export const retryDeliveriesSchema = z.object({
  endpointId: z
    .string()
    .optional()
    .describe("One endpoint's failed deliveries; every endpoint's without it."),
  since: z.iso
    .datetime()
    .optional()
    .describe(
      'Deliveries created at or after this time: the start of the outage.',
    ),
});
export type RetryDeliveriesDto = z.infer<typeof retryDeliveriesSchema>;

const DELIVERY_STATUSES = ['pending', 'succeeded', 'failed'] as const;

const epochMs = z.number().describe('Epoch milliseconds.');
const isoTime = z.iso.datetime();

/** A webhook endpoint, as the API returns it (never with its secret). */
export const webhookEndpointSchema = z.object({
  id: z.string(),
  tenant: z.string().nullable(),
  url: z.string(),
  eventTypes: z.array(z.string()),
  description: z.string().nullable(),
  enabled: z.boolean(),
  disabledReason: z.enum(['manual', 'failing', 'gone']).nullable(),
  failingSince: epochMs.nullable(),
  createdAt: epochMs,
  updatedAt: epochMs,
});

/** `POST /webhook-endpoints`: the endpoint and its secret, shown this once. */
export const createdWebhookEndpointSchema = webhookEndpointSchema.extend({
  secret: z
    .string()
    .describe(
      'Standard Webhooks whsec_…: verify the signatures with it. Shown this once.',
    ),
});

export const rotatedSecretSchema = z.object({
  secret: z
    .string()
    .describe(
      'The new whsec_…. The old one keeps signing next to it for 24 hours.',
    ),
});

/** A signing secret, by its creation time: its identifier. Never the secret. */
export const signingSecretSchema = z.object({
  createdAt: isoTime.describe(
    "When the secret was made (the creation or the rotation that issued it): its identifier, to match with the rotations' times.",
  ),
  expiresAt: isoTime
    .nullable()
    .describe(
      'When it stops signing: a rotated-out secret, 24 hours after the rotation; null for the current one.',
    ),
});

/** One delivery of a message to an endpoint. */
export const webhookDeliverySchema = z.object({
  id: z.string(),
  messageId: z
    .string()
    .describe('The webhook-id header: the same on every attempt and replay.'),
  endpointId: z.string(),
  tenant: z.string().nullable(),
  type: z.string(),
  status: z.enum(DELIVERY_STATUSES),
  attempts: z.int(),
  nextAttemptAt: isoTime.nullable(),
  lastAttemptAt: isoTime.nullable(),
  lastStatusCode: z.int().nullable(),
  lastError: z.string().nullable(),
  failureReason: z
    .enum(['exhausted', 'rejected', 'endpoint-disabled', 'endpoint-deleted'])
    .nullable(),
  createdAt: isoTime,
  completedAt: isoTime.nullable(),
});

/** A delivery with the message that was sent and every attempt. */
export const webhookDeliveryDetailsSchema = webhookDeliverySchema.extend({
  message: z.object({
    id: z.string(),
    type: z.string(),
    tenant: z.string().nullable(),
    body: z.string().describe('The exact JSON that was signed and sent.'),
    createdAt: isoTime,
  }),
  history: z.array(
    z.object({
      deliveryId: z.string(),
      attempt: z.int(),
      at: isoTime,
      durationMs: z.number(),
      statusCode: z.int().nullable(),
      response: z
        .string()
        .nullable()
        .describe('The first 4 KB of the response body.'),
      error: z.string().nullable(),
    }),
  ),
});

/**
 * `GET …/webhook-deliveries/{id}`: the delivery with its message, every
 * attempt, the time they took and the request last sent.
 */
export const webhookDeliveryViewSchema = webhookDeliveryDetailsSchema.extend({
  durationMs: z
    .number()
    .describe('Every attempt of the log together, in milliseconds.'),
  lastRequest: z
    .object({
      attempt: z.int().describe('1-based, within its round.'),
      sentAt: isoTime,
      headers: z
        .record(z.string(), z.string())
        .describe(
          'As sent: webhook-id, webhook-timestamp, webhook-signature (v1,… per live secret), content-type, user-agent. Never the secret.',
        ),
      signedWith: z
        .array(signingSecretSchema)
        .nullable()
        .describe(
          'The secrets that signed that attempt, newest first, in the order of the v1,… signatures: one normally, two during the overlap after a rotation. Identified by when each was made, never revealed. Null: not recorded (a delivery from before this was kept).',
        ),
    })
    .nullable()
    .describe('The request of the latest attempt; null before the first.'),
});

/** `GET /v1/webhook-event-types`: what an endpoint may subscribe to, by feature. */
export const webhookEventTypesSchema = z.object({
  items: z.array(
    z.object({
      group: z
        .string()
        .describe("The feature: the types' first segment unless declared."),
      types: z.array(
        z.object({
          type: z.string().meta({ example: 'note.published' }),
          description: z.string().nullable(),
        }),
      ),
    }),
  ),
});

export const retriedSchema = z.object({
  retried: z.int().describe('How many deliveries were sent again.'),
});

/** `GET`/`PUT /access/clients/{clientId}/webhook-scope`: which records' events the client's endpoints receive. */
export const webhookScopeSchema = z.object({
  scope: z
    .enum(WEBHOOK_SCOPES)
    .describe(
      "own (the default): only the records the client owns. tenant: also its tenant's records owned by users and other clients, each only when the client may read it, without the fields it may not read.",
    ),
});
export type WebhookScopeDto = z.infer<typeof webhookScopeSchema>;
