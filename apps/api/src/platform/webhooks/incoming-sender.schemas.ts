import { z } from 'zod';
import { listSchema } from '../../core/http/pagination.js';

/** A sender's name: the last segment of its URL. */
const senderName = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,62})$/, {
    message: 'Lower-case letters, digits and hyphens, at most 63 characters.',
  })
  .meta({ example: 'billing-system' });

/** A tenant's incoming webhook sender, never with its secret. */
export const incomingSenderSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    enabled: z.boolean(),
    path: z
      .string()
      .describe(
        'Where the sender POSTs, under the API origin: `/v1/webhooks/tenants/{tenantId}/senders/{name}`.',
      ),
    previousSecretExpiresAt: z.iso
      .datetime()
      .nullable()
      .describe(
        'While set and in the future, the secret before the last rotation still verifies.',
      ),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: 'IncomingWebhookSender' });

/** A sender with its secret: shown once, at creation and at rotation. */
export const createdIncomingSenderSchema = incomingSenderSchema
  .extend({
    secret: z
      .string()
      .describe(
        'The `whsec_…` signing secret (Standard Webhooks). Shown this once.',
      ),
  })
  .meta({ id: 'CreatedIncomingWebhookSender' });

export const incomingSenderListSchema = listSchema(incomingSenderSchema).meta({
  id: 'IncomingWebhookSenderList',
});

/** Body of `POST /webhook-senders`. */
export const createIncomingSenderSchema = z.object({
  name: senderName,
  description: z.string().trim().min(1).max(500).optional(),
});
export type CreateIncomingSenderDto = z.infer<
  typeof createIncomingSenderSchema
>;

/** Body of `PATCH /webhook-senders/{id}`: only what is sent changes. */
export const updateIncomingSenderSchema = z.object({
  description: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .nullable()
    .optional()
    .describe('null clears it.'),
  enabled: z
    .boolean()
    .optional()
    .describe('false: the sender is refused (401) until it is enabled again.'),
});
export type UpdateIncomingSenderDto = z.infer<
  typeof updateIncomingSenderSchema
>;

/** Body of `POST /webhook-senders/{id}/rotate-secret`. */
export const rotateIncomingSenderSchema = z.object({
  graceSeconds: z
    .number()
    .int()
    .min(0)
    .max(7 * 24 * 3600)
    .default(24 * 3600)
    .describe(
      'How long the old secret keeps verifying (default 24 hours; 0: it stops now).',
    ),
});
export type RotateIncomingSenderDto = z.infer<
  typeof rotateIncomingSenderSchema
>;

/** The answer of the receiver route. */
export const incomingEventResultSchema = z
  .object({
    received: z.literal(true),
    duplicate: z.boolean(),
    handled: z
      .boolean()
      .describe(
        'false: no handler is registered for the event type (acknowledged and ignored, so the sender does not retry).',
      ),
  })
  .meta({ id: 'IncomingWebhookResult' });

/** What a tenant sender POSTs: Standard Webhooks headers, and this envelope. */
export const incomingEventSchema = z.object({
  type: z.string().min(1).max(200).meta({ example: 'note.publish-requested' }),
  data: z.unknown(),
});
export type IncomingEvent = z.infer<typeof incomingEventSchema>;
