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

export const unreadCountSchema = z.object({
  unread: z.int().meta({
    description:
      '`unread` stops at 1,000; `unreadCapped` is then true (show 1,000+).',
  }),
  unreadCapped: z.boolean(),
});

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

/**
 * What each channel's setting holds (`NotificationChannelSettings`): the
 * channels declare these, and the API documents them. In-app and realtime
 * are always on and not settings.
 */
export const emailSettingSchema = z.union([
  z.enum(['immediate', 'hourly', 'daily']),
  z.literal(false),
]);
export const webhookSettingSchema = z.boolean();

const emailDescription =
  'Users only: `false` (no mail), `immediate`, or bundled into an `hourly` or `daily` digest.';
const smsDescription =
  'Users with a verified phone number only, when SMS is configured: whether the notification is also texted.';
const pushDescription =
  'Users with a registered device only, when push is configured: whether the notification is also pushed.';
const webhookDescription =
  'API clients only: whether the `notification.created` webhook is sent.';

/** The channels a caller may set, with their settings: `email`, `sms` and `push` for users, `webhook` for API clients. */
export const channelSettingsSchema = z.object({
  email: emailSettingSchema.optional().describe(emailDescription),
  webhook: webhookSettingSchema.optional().describe(webhookDescription),
  sms: z.boolean().optional().describe(smsDescription),
  push: z.boolean().optional().describe(pushDescription),
});

/**
 * The same for the body of PUT. Loose, so a channel this schema doesn't
 * know (or one the caller's kind can't set) reaches the service, which
 * refuses it by name (`<type>.<channel>`); the known ones are checked here.
 */
export const channelSettingsInputSchema = z.looseObject({
  email: emailSettingSchema.optional().describe(emailDescription),
  webhook: webhookSettingSchema.optional().describe(webhookDescription),
  sms: z.boolean().optional().describe(smsDescription),
  push: z.boolean().optional().describe(pushDescription),
});

const clock = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM, 24-hour clock');

/** The body of PUT /notifications/quiet-hours. */
export const quietHoursInputSchema = z
  .object({
    start: clock.meta({ example: '22:00' }),
    end: clock.meta({ example: '07:00' }),
  })
  .refine((value) => value.start !== value.end, {
    path: ['end'],
    message: 'The window must not be empty: start and end differ.',
  });

/** Your quiet hours, or null: push and SMS wait for the window to end (urgent types do not). */
export const quietHoursViewSchema = z.object({
  quietHours: z
    .object({
      start: clock,
      end: clock,
      timezone: z
        .string()
        .describe(
          'The time zone whose clock the window follows: yours, else the deployment’s.',
        ),
    })
    .nullable(),
});

/** A declared type, as the catalog shows it to this caller. */
export const notificationTypeSchema = z.object({
  type: z.string().meta({ example: 'note.published' }),
  label: z.string().describe("In the request's language."),
  mandatory: z
    .boolean()
    .describe(
      'Its channels cannot be switched off (their frequency may change).',
    ),
  urgent: z.boolean().describe('Push and SMS go through quiet hours at once.'),
  channels: channelSettingsSchema.describe(
    'The defaults of the channels you may set (in-app and realtime are always on).',
  ),
});

/** Your effective settings, per type, for the channels you may set. */
export const preferencesViewSchema = z.object({
  types: z.record(z.string(), channelSettingsSchema).meta({
    example: { 'note.published': { email: 'daily' } },
  }),
});

/** The body of PUT: the full set of your overrides (checked against the declared types and your channels). */
export const preferencesInputSchema = z
  .record(z.string().max(100), channelSettingsInputSchema)
  .meta({ example: { 'note.published': { email: 'daily' } } })
  .describe(
    'Per type, the channels to change: a type or channel left out keeps its default.',
  );

/** What the test notification answers: the stored notification, delivered on its way. */
export const testNotificationResultSchema = z.object({
  id: z.uuid().describe('The notification, delivered to you shortly.'),
});

/**
 * The body of the one-click unsubscribe (RFC 8058 §3.1): a mail client posts
 * the form `List-Unsubscribe=One-Click`. The web page's JSON body with the
 * same field is read the same.
 */
export const unsubscribeSchema = z.object({
  'List-Unsubscribe': z
    .literal('One-Click')
    .describe('Always `One-Click` (RFC 8058).'),
});

/**
 * What an unsubscribe link stops (`GET`, the read-only twin of the POST): a
 * notification type, or a digest. Never the person's email or id.
 */
export const unsubscribeDescriptionSchema = z
  .discriminatedUnion('kind', [
    z.object({
      kind: z.literal('type'),
      label: z
        .string()
        .nullable()
        .describe(
          "What the notification type is called, in the request's language. Null when the link would change nothing (the type is gone, or mandatory): the client then speaks generally.",
        ),
    }),
    z.object({
      kind: z.literal('digest'),
      modes: z
        .array(z.enum(['hourly', 'daily']))
        .describe(
          'The digests the link stands for: every type the person gets in these modes.',
        ),
    }),
  ])
  .meta({ example: { kind: 'type', label: 'Mentioned in a comment' } });
