import { z } from 'zod';
import { timezone } from '../../iam/account/account.schemas.js';
import { TRANSFER_FORMATS } from '../data-transfer/data-transfer.types.js';

const hour = z.number().int().min(0).max(23).describe('0-23, in `timezone`.');

/** When a report runs; no raw cron. */
export const reportScheduleSchema = z
  .discriminatedUnion('every', [
    z.object({ every: z.literal('daily'), hour }),
    z.object({
      every: z.literal('weekly'),
      weekday: z
        .number()
        .int()
        .min(0)
        .max(6)
        .describe('0 Sunday … 6 Saturday.'),
      hour,
    }),
    z.object({
      every: z.literal('monthly'),
      day: z
        .number()
        .int()
        .min(1)
        .max(28)
        .describe('1-28: every month has it.'),
      hour,
    }),
  ])
  .meta({ example: { every: 'weekly', weekday: 1, hour: 8 } });

/** At most this many recipients per report. */
export const MAX_RECIPIENTS = 20;

const recipients = z
  .array(z.email().max(254))
  .min(1)
  .max(MAX_RECIPIENTS)
  .describe(`Up to ${MAX_RECIPIENTS} addresses.`);

/** A scheduled report. */
export const reportSchema = z.object({
  id: z.string(),
  name: z.string().meta({ example: 'Weekly drafts' }),
  exporter: z.string().meta({ example: 'notes' }),
  format: z.enum(TRANSFER_FORMATS),
  filters: z.record(z.string(), z.string()),
  timezone: z.string().meta({ example: 'Asia/Manila' }),
  schedule: reportScheduleSchema,
  recipients: z.array(z.string()),
  active: z.boolean(),
  lastRunAt: z.iso.datetime().nullable(),
  lastStatus: z.enum(['completed', 'failed']).nullable(),
  lastTransferId: z
    .string()
    .nullable()
    .describe('The last run: `GET /v1/data/transfers/{id}`.'),
  nextRunAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

/** Body of `POST /reports`. */
export const createReportSchema = z.object({
  name: z.string().trim().min(1).max(200).meta({ example: 'Weekly drafts' }),
  exporter: z
    .string()
    .min(1)
    .max(80)
    .describe('An export you may run (`GET /v1/data`).')
    .meta({ example: 'notes' }),
  format: z.enum(TRANSFER_FORMATS).default('csv'),
  filters: z
    .record(z.string(), z.string())
    .default({})
    .describe(
      'The list filters of that data, as on its list route: { "status": "draft" }.',
    ),
  timezone: timezone
    .optional()
    .describe(
      "The schedule's hours and the file's dates. Default: your own time zone, else the server's (APP_TIMEZONE).",
    ),
  schedule: reportScheduleSchema,
  recipients: recipients
    .optional()
    .describe(
      `Up to ${MAX_RECIPIENTS} addresses. Default for a user: their own; required for an API client.`,
    ),
  active: z.boolean().default(true),
});
export type CreateReportDto = z.infer<typeof createReportSchema>;

/** Body of `PATCH /reports/{id}`: only what is sent changes. */
export const updateReportSchema = z.object({
  name: createReportSchema.shape.name.optional(),
  exporter: createReportSchema.shape.exporter.optional(),
  format: z.enum(TRANSFER_FORMATS).optional(),
  filters: z.record(z.string(), z.string()).optional(),
  timezone: timezone.optional(),
  schedule: reportScheduleSchema.optional(),
  recipients: recipients.optional(),
  active: z.boolean().optional(),
});
export type UpdateReportDto = z.infer<typeof updateReportSchema>;

/** `POST /reports/{id}/run`'s answer: the export started. */
export const reportRunSchema = z.object({
  id: z.string().describe('The transfer: `GET /v1/data/transfers/{id}`.'),
  status: z.literal('queued'),
});
