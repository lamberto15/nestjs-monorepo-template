import { z } from 'zod';
import { pageSchema } from '../../core/http/pagination.js';

/** A legal hold. */
export const legalHoldSchema = z
  .object({
    id: z.string(),
    subject: z
      .string()
      .describe('What is held: a permission subject, `Note`.')
      .meta({ example: 'Note' }),
    recordId: z
      .string()
      .nullable()
      .describe('The held record; null holds every record of the subject.'),
    reason: z.string().meta({ example: 'Dispute with Acme, case 2026-114' }),
    active: z.boolean(),
    placedBy: z.string(),
    placedAt: z.iso.datetime(),
    releasedAt: z.iso.datetime().nullable(),
    releasedBy: z.string().nullable(),
    releaseNote: z.string().nullable(),
  })
  .meta({ id: 'LegalHold' });

/** A page of legal holds (`GET /v1/legal-holds`). */
export const legalHoldPageSchema = pageSchema(legalHoldSchema).meta({
  id: 'LegalHoldPage',
});

/** Body of `POST /legal-holds`. */
export const placeLegalHoldSchema = z.object({
  subject: z
    .string()
    .regex(/^[A-Z][A-Za-z0-9]*$/, {
      message: 'A subject is a name such as Note.',
    })
    .max(100)
    .describe('A permission subject: `Note`, or `User` for a person.')
    .meta({ example: 'Note' }),
  recordId: z
    .uuid()
    .optional()
    .describe('One record; leave out to hold every record of the subject.'),
  reason: z.string().trim().min(1).max(1000),
});
export type PlaceLegalHoldDto = z.infer<typeof placeLegalHoldSchema>;

/** Body of `POST /legal-holds/{id}/release`. */
export const releaseLegalHoldSchema = z.object({
  note: z.string().trim().max(1000).optional(),
});
export type ReleaseLegalHoldDto = z.infer<typeof releaseLegalHoldSchema>;
