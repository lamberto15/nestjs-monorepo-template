import { z } from 'zod';

/** A notification as the API shows it: the texts in the request's language. */
export const notificationSchema = z.object({
  id: z.uuid(),
  type: z.string().meta({ example: 'note.published' }),
  title: z.string(),
  body: z.string(),
  data: z
    .record(z.string(), z.unknown())
    .describe(
      'What the texts were made from, and what a client needs to act on it.',
    ),
  link: z.string().nullable().describe('A path of the web app, or null.'),
  key: z.string().nullable().describe('The collapse key, when it has one.'),
  count: z
    .int()
    .describe('How many notifications this one stands for (collapsed).'),
  read: z.boolean(),
  readAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type NotificationView = z.infer<typeof notificationSchema>;

export const unreadCountSchema = z.object({ unread: z.int() });

export const readAllSchema = z
  .object({
    before: z.iso
      .datetime()
      .optional()
      .describe(
        'Only those created before this moment (what the client has shown).',
      ),
  })
  .strict();

export const readAllResultSchema = z.object({ updated: z.int() });

/** A declared type, as the catalog shows it to this caller. */
export const notificationTypeSchema = z.object({
  type: z.string().meta({ example: 'note.published' }),
  label: z.string().describe("In the request's language."),
  mandatory: z
    .boolean()
    .describe(
      'Its channels cannot be switched off (their frequency may change).',
    ),
  channels: z
    .record(z.string(), z.unknown())
    .describe(
      'The defaults of the channels you may set: `email` (false | immediate | hourly | daily) for users, `webhook` (boolean) for API clients.',
    ),
});

/** Your effective settings, per type, for the channels you may set. */
export const preferencesViewSchema = z.object({
  types: z.record(z.string(), z.record(z.string(), z.unknown())).meta({
    example: { 'note.published': { email: 'daily' } },
  }),
});

/** The body of PUT: the full set of your overrides (checked against the declared types and your channels). */
export const preferencesInputSchema = z
  .record(z.string().max(100), z.record(z.string().max(50), z.unknown()))
  .meta({ example: { 'note.published': { email: 'daily' } } })
  .describe(
    'Per type, the channels to change: a type or channel left out keeps its default.',
  );
