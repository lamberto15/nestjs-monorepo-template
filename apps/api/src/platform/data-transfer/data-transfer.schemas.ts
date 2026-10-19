import { z } from 'zod';
import { TRANSFER_LINK_TTL } from './data-transfer.service.js';
import { TRANSFER_FORMATS } from './data-transfer.types.js';

/** The 202 of a transfer started: follow it by its id. */
export const startedSchema = z.object({
  id: z.string().describe('Follow it at GET /v1/data/transfers/{id}.'),
  status: z.literal('queued'),
});

/** A transfer as GET /v1/data/transfers/{id} (and each item of the lists) tells it. */
export const statusSchema = z.object({
  id: z.string(),
  kind: z.enum(['export', 'import']),
  name: z.string(),
  format: z.enum(TRANSFER_FORMATS),
  status: z.enum(['queued', 'running', 'completed', 'failed']),
  progress: z.record(z.string(), z.number()),
  createdAt: z.iso.datetime().describe('When it was started.'),
  finishedAt: z.iso
    .datetime()
    .nullable()
    .describe('When it completed or failed; null while it waits or runs.'),
  expiresAt: z.iso
    .datetime()
    .nullable()
    .describe(
      'When it is no longer kept (7 days after it ended): from then on it is neither listed nor found, nor its link given. null while it waits or runs.',
    ),
  result: z
    .object({
      rows: z.number(),
      url: z.url().optional().describe(`The file, for ${TRANSFER_LINK_TTL}.`),
      imported: z.number().optional(),
      failed: z.number().optional(),
      dryRun: z.boolean().optional(),
      errorsUrl: z
        .url()
        .optional()
        .describe('A CSV of the refused rows: row, field, message.'),
    })
    .optional(),
  error: z.string().optional(),
});
