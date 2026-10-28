import { z } from 'zod';
import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  pageSchema,
} from '../../core/http/pagination.js';

export const inboxQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  cursor: z.string().min(1).max(2000).optional(),
  source: z
    .string()
    .max(50)
    .optional()
    .describe('Only this source: `approval`, `mention`.'),
});
export type InboxQuery = z.infer<typeof inboxQuerySchema>;

export const inboxItemSchema = z.object({
  key: z
    .string()
    .describe('`<source>:<id>`: the item, for dismissing it.')
    .meta({ example: 'approval:0190a0a0-0000-7000-8000-000000000000' }),
  source: z.string().meta({ example: 'approval' }),
  kind: z
    .string()
    .describe(
      'What the work is: `approval.decide`, `approval.revise`, `mention`.',
    )
    .meta({ example: 'approval.decide' }),
  at: z.iso
    .datetime()
    .describe('When it came to you; the list is newest first.'),
  dueAt: z.iso.datetime().nullable(),
  link: z
    .string()
    .nullable()
    .describe('Where to do it, a path of the web app.'),
  subject: z.string().nullable(),
  recordId: z.string().nullable(),
  data: z
    .record(z.string(), z.unknown())
    .describe('What the client words the item with: a title, who asked.'),
  canDismiss: z
    .boolean()
    .describe(
      'false: it is done at its source (decide the request), not here.',
    ),
});

export const inboxPageSchema = pageSchema(inboxItemSchema);

export const dismissInboxSchema = z.object({
  key: z.string().min(3).max(200),
});
export type DismissInboxDto = z.infer<typeof dismissInboxSchema>;
