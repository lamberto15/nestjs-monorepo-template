import { z } from 'zod';
import { MAX_BULK_IDS, MAX_BULK_RESULTS } from './bulk.types.js';

/**
 * The body of a feature's `POST /<x>/bulk`: its actions, and the input
 * schema of those that take one (documented; BulkService checks it per action).
 */
export const bulkRequestSchema = <
  const A extends readonly [string, ...string[]],
>(
  actions: A,
  input?: z.ZodType,
) =>
  z.object({
    action: z.enum(actions),
    ids: z
      .array(z.uuid())
      .min(1)
      .optional()
      // Documented, not enforced here: BulkService answers bulk_too_many.
      .meta({ maxItems: MAX_BULK_IDS })
      .describe(
        `These records (1 to ${MAX_BULK_IDS}); those you may not act on are skipped. Send ids or filter.`,
      ),
    filter: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        'Every record matching these list filters, as on the list route: { "status": "draft", "title.startsWith": "Old" }. Always a background job.',
      ),
    input: (input ?? z.record(z.string(), z.unknown()))
      .optional()
      .describe('What the action takes (update: the PATCH body).'),
  });

const itemErrorSchema = z.object({
  code: z.string().meta({ example: 'field_forbidden' }),
  message: z.string(),
  errors: z
    .array(z.object({ path: z.string(), message: z.string() }))
    .optional(),
});

/** What a run did: exact counts, then one result per item. */
export const bulkResultSchema = z.object({
  done: z.number(),
  failed: z.number(),
  skipped: z
    .number()
    .describe('Ids not found, or not yours to act on (code not_found).'),
  results: z.array(
    z.object({
      id: z.string(),
      status: z.enum(['done', 'failed', 'skipped']),
      error: itemErrorSchema
        .optional()
        .describe(
          "Why it failed: the problem the record's own route would have answered.",
        ),
    }),
  ),
  truncated: z
    .boolean()
    .optional()
    .describe(
      `A background job keeps ${MAX_BULK_RESULTS} results; true when there were more.`,
    ),
});

/** A run handed to the workers: follow it at GET /v1/bulk/{id}. */
export const bulkStartedSchema = z.object({
  id: z.string(),
  status: z.literal('queued'),
});

/** GET /v1/bulk/{id}. */
export const bulkStatusSchema = z.object({
  id: z.string(),
  name: z.string(),
  action: z.string(),
  status: z.enum(['queued', 'running', 'completed', 'failed']),
  progress: z
    .record(z.string(), z.number())
    .describe('processed, done, failed: every 100 items.'),
  result: bulkResultSchema.optional(),
  error: z.string().optional(),
});
