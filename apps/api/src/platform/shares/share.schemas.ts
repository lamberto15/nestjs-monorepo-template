import { z } from 'zod';

/** The longest a link may work: past it, make a new one. */
export const SHARE_MAX_DAYS = 30;
/** At most this many working links (not revoked, not expired) per record. */
export const MAX_SHARES_PER_RECORD = 20;
/** How long a mailed code opens a link to a recipient, and how many wrong tries it takes. */
export const SHARE_CODE_MINUTES = 10;
export const SHARE_CODE_ATTEMPTS = 5;

/** `shr_<tenant id>_<secret>`: what the link's fragment carries. */
const tokenSchema = z
  .string()
  .max(200)
  .describe(
    "The link's token: the part of the link after `#`. Sent in the body, never in a URL, so no log or `Referer` carries it.",
  );

/** One link to a record, as its makers see it: never its token. */
export const shareSchema = z
  .object({
    id: z.string(),
    subject: z.string().meta({ example: 'Note' }),
    recordId: z.string(),
    fields: z.array(z.string()).meta({ example: ['title', 'body'] }),
    files: z.boolean(),
    recipientEmail: z
      .string()
      .nullable()
      .describe('Set: the link opens only with a code mailed to this address.'),
    createdBy: z.string().describe('`user:<id>` of who made it.'),
    expiresAt: z.iso.datetime(),
    revokedAt: z.iso.datetime().nullable(),
    /** Whether it still opens: neither revoked nor expired. */
    active: z.boolean(),
    views: z.int(),
    lastViewedAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'Share' });
export type ShareView = z.infer<typeof shareSchema>;

export const shareListSchema = z
  .object({ items: z.array(shareSchema) })
  .meta({ id: 'ShareList' });

/** A new link: the token and the URL are in this answer only. */
export const createdShareSchema = shareSchema
  .extend({
    token: z.string().describe('Shown once: only its hash is kept.'),
    url: z
      .string()
      .describe(
        "The web app's page that opens it: `<WEB_URL>/shared#<token>`.",
      ),
  })
  .meta({ id: 'CreatedShare' });

export const createShareSchema = z.object({
  fields: z
    .array(z.string().min(1).max(100))
    .min(1)
    .max(100)
    .describe(
      "The record's fields the link shows: fields you may read, never a reference to another record.",
    ),
  files: z
    .boolean()
    .default(false)
    .describe(
      "List the record's files, and hand out their download links: only files that show no field outside `fields`.",
    ),
  expiresAt: z.iso
    .datetime()
    .describe(`When the link stops: within ${SHARE_MAX_DAYS} days.`),
  recipientEmail: z
    .email()
    .max(254)
    .optional()
    .describe(
      'Only this address opens it: a code is mailed to it each time (POST /v1/shared/code).',
    ),
});
export type CreateShareDto = z.infer<typeof createShareSchema>;

export const openShareSchema = z.object({
  token: tokenSchema,
  code: z
    .string()
    .regex(/^\d{6}$/)
    .optional()
    .describe('The code mailed to the recipient, for a link that has one.'),
});
export type OpenShareDto = z.infer<typeof openShareSchema>;

export const shareCodeSchema = z.object({ token: tokenSchema });
export type ShareCodeDto = z.infer<typeof shareCodeSchema>;

/** What a link shows: the shared fields of the record, nothing else. */
export const sharedRecordSchema = z.object({
  subject: z.string().meta({ example: 'Note' }),
  fields: z
    .record(z.string(), z.unknown())
    .describe(
      'The shared fields, as reading the record shows them: one its maker may no longer read is left out.',
    ),
  files: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        size: z.int(),
        contentType: z.string(),
      }),
    )
    .describe('Its files, when the link shares them (else empty).'),
  expiresAt: z.iso.datetime(),
});

export const sharedFileLinkSchema = z.object({
  url: z.string().describe('A signed link to the file, valid for 5 minutes.'),
});
