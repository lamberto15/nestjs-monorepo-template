import { z } from 'zod';
import { DOCUMENT_STATUSES } from './documents.tables.js';

/** A document asked for: its state, then the issued PDF (an attachment of the record). */
export const documentSchema = z.object({
  id: z.uuid(),
  source: z
    .string()
    .meta({ example: 'note' })
    .describe('What kind of document.'),
  subject: z.string().meta({ example: 'Note' }),
  recordId: z.uuid(),
  locale: z
    .string()
    .meta({ example: 'en' })
    .describe('The language it is written in.'),
  status: z
    .enum(DOCUMENT_STATUSES)
    .describe('queued → rendering → completed, or failed (then `error`).'),
  attachmentId: z
    .uuid()
    .nullable()
    .describe(
      'Once completed: the PDF, an attachment of the record (GET /v1/attachments/{id}/download).',
    ),
  error: z.string().nullable().describe('Why it failed, written for people.'),
  issuedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type DocumentView = z.infer<typeof documentSchema>;

/** A document handed to the workers: follow it at GET /v1/documents/{id}. */
export const documentQueuedSchema = z.object({
  id: z.uuid(),
  status: z.literal('queued'),
});
