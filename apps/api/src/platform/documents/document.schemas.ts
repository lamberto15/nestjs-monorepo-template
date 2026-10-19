import { z } from 'zod';
import { pageSchema } from '../../core/http/pagination.js';
import { REGIONS, SHIPPED_LOCALES } from '../../core/i18n/locales.js';
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

/** A document of a record, as the record's documents list shows it (`GET /v1/<plural>/{id}/documents`). */
export const recordDocumentSchema = z
  .object({
    id: z.uuid(),
    status: z
      .enum(DOCUMENT_STATUSES)
      .describe('queued → rendering → completed, or failed (then `error`).'),
    template: z
      .string()
      .meta({ example: 'note' })
      .describe(
        'The template it was issued from: an `id` of `documentTemplates` in GET /v1/lists/{subject}.',
      ),
    language: z
      .string()
      .meta({ example: 'en' })
      .describe('The language it is written in (`?lang=` of the request).'),
    issuedBy: z
      .object({
        key: z
          .string()
          .meta({ example: 'user:0199a3f2-…' })
          .describe(
            'Who asked for it: `user:<id>`, `client:<id>`, or `anonymized`.',
          ),
        name: z
          .string()
          .nullable()
          .describe(
            'Their name (a member or former member, an API client of the tenant); null when there is none (`anonymized`, a removed client).',
          ),
      })
      .describe('Who asked for it.'),
    createdAt: z.iso.datetime(),
    finishedAt: z.iso
      .datetime()
      .nullable()
      .describe(
        'When it was issued (`completed`) or failed; null while queued or rendering.',
      ),
    attachmentId: z
      .uuid()
      .nullable()
      .describe(
        'Once completed: the PDF, an attachment of the record (GET /v1/attachments/{id}/download, `?inline=true` to show it).',
      ),
    error: z.string().nullable().describe('Why it failed, written for people.'),
  })
  .meta({ id: 'RecordDocument' });
export type RecordDocumentView = z.infer<typeof recordDocumentSchema>;

/** A page of a record's documents, newest first. */
export const recordDocumentPageSchema = pageSchema(recordDocumentSchema).meta({
  id: 'RecordDocumentPage',
});

/** A template a subject's documents are issued from, in one language. */
export const documentTemplateSchema = z.object({
  id: z
    .string()
    .meta({ example: 'note' })
    .describe(
      "The template: a record's documents name it as `template`; POST …/{id}/pdf issues it.",
    ),
  language: z
    .string()
    .meta({ example: 'ar' })
    .describe('A language it is written in: `?lang=` of POST …/{id}/pdf.'),
});
export type DocumentTemplate = z.infer<typeof documentTemplateSchema>;

/**
 * The languages `?lang=` may name for a document: the catalogs the app
 * ships (LOCALES may enable fewer: GET /v1/features `locales`), and the
 * regions that read them (ar-AE…: their own date and number formats).
 */
export const DOCUMENT_LANGUAGES = [
  ...SHIPPED_LOCALES,
  ...Object.keys(REGIONS),
] as [string, ...string[]];
