import { z } from 'zod';
import { SUPPRESSION_REASONS } from '../../core/mail/mail-suppression.js';

/** An entry of the suppression list. */
export const mailSuppressionSchema = z.object({
  id: z.string(),
  address: z.string().meta({ example: 'ada@example.com' }),
  reason: z
    .enum(SUPPRESSION_REASONS)
    .describe(
      '`hard_bounce` (no such mailbox), `soft_bounce` (refused MAIL_SOFT_BOUNCE_THRESHOLD times in a row), `complaint` (reported as spam), `manual`.',
    ),
  source: z
    .string()
    .describe('The provider that reported it (`ses`), or `manual`.'),
  note: z.string().nullable(),
  lastDetail: z
    .string()
    .nullable()
    .describe(
      'The provider’s last word: a bounce sub-type, a diagnostic code.',
    ),
  events: z.number().int().describe('Bounces and complaints reported for it.'),
  softBounces: z.number().int().describe('Transient bounces in a row.'),
  firstSeenAt: z.iso.datetime(),
  lastSeenAt: z.iso.datetime(),
  suppressedAt: z.iso
    .datetime()
    .nullable()
    .describe(
      'Null: only watched (soft bounces under the threshold); set: mail is not sent to it.',
    ),
  skipped: z.number().int().describe('Mails not sent to it since.'),
  lastSkippedAt: z.iso.datetime().nullable(),
  createdBy: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type MailSuppressionView = z.infer<typeof mailSuppressionSchema>;

/** Body of `POST /mail/suppressions`: an address an administrator stops mail to. */
export const createMailSuppressionSchema = z.object({
  address: z.email().max(320).meta({ example: 'ada@example.com' }),
  note: z.string().trim().max(500).optional(),
});
export type CreateMailSuppressionDto = z.infer<
  typeof createMailSuppressionSchema
>;
