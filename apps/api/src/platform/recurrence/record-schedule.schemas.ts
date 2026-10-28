import { z } from 'zod';
import { timezone } from '../../iam/account/account.schemas.js';
import { minuteOf } from '../calendars/calendar-time.js';
import { MAX_OCCURRENCES, parseRule, RuleError } from './recurrence-rule.js';

/** Most active schedules per owner, preview occurrences, and template size in bytes. */
export const MAX_ACTIVE_SCHEDULES = 20;
export const MAX_PREVIEW = 20;
export const MAX_TEMPLATE_BYTES = 16_384;

const rrule = z
  .string()
  .trim()
  .min(5)
  .max(200)
  .superRefine((value, context) => {
    try {
      parseRule(value);
    } catch (error) {
      if (!(error instanceof RuleError)) throw error;
      context.addIssue({ code: 'custom', message: error.message });
    }
  })
  .describe(
    `An RFC 5545 RRULE, a subset: FREQ (DAILY, WEEKLY, MONTHLY, YEARLY), INTERVAL, BYDAY (weekly: MO,WE), BYMONTHDAY (monthly), and COUNT or UNTIL (20261231). At most ${MAX_OCCURRENCES} records per schedule. A month without the day (the 31st) has no occurrence.`,
  )
  .meta({ example: 'FREQ=WEEKLY;BYDAY=MO;COUNT=26' });

const startDate = z.iso
  .date()
  .describe("The first date that may occur, in the schedule's zone.")
  .meta({ example: '2026-11-02' });

const time = z
  .string()
  .regex(/^\d{2}:\d{2}$/)
  .refine((value) => minuteOf(value) < 1440, 'HH:MM, from 00:00 to 23:59')
  .describe("Time of day of each occurrence, in the schedule's zone.")
  .meta({ example: '08:30' });

const template = z
  .record(z.string(), z.unknown())
  .refine(
    (value) => JSON.stringify(value).length <= MAX_TEMPLATE_BYTES,
    `At most ${MAX_TEMPLATE_BYTES} bytes.`,
  )
  .describe(
    'One row of the importer, as its file import takes it (`GET /v1/data/imports/{name}/template` lists the columns); checked on create and again at every occurrence, as the owner. The same values are used each time.',
  )
  .meta({ example: { title: 'Weekly review', body: 'Check the board.' } });

const calendarId = z
  .uuid()
  .describe(
    'A business calendar (`GET /v1/calendars`): an occurrence outside its working time moves to its next working moment; occurrences that land on the same moment make one record.',
  );

/** A recurring record schedule. */
export const recordScheduleSchema = z
  .object({
    id: z.uuid(),
    name: z.string().meta({ example: 'Weekly review' }),
    importer: z.string().meta({ example: 'notes' }),
    template,
    rrule,
    startDate,
    time,
    timezone: z.string().meta({ example: 'Europe/Berlin' }),
    calendarId: z.uuid().nullable(),
    status: z.enum(['active', 'paused', 'ended']),
    endReason: z
      .string()
      .nullable()
      .describe(
        '`completed`, `ended` (by its owner), `owner_inactive`, `import_not_allowed`, `template_invalid`.',
      ),
    occurrences: z
      .int()
      .describe(
        'Occurrences handled: created, or skipped after failing for good.',
      ),
    maxOccurrences: z.int().nullable(),
    failures: z
      .int()
      .describe('Failed attempts at the occurrence due now (3 skip it).'),
    lastError: z.string().nullable(),
    lastRunAt: z.iso.datetime().nullable(),
    lastStatus: z.enum(['created', 'failed']).nullable(),
    nextRunAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: 'RecordSchedule' });

/** Body of `POST /record-schedules`. */
export const createRecordScheduleSchema = z.object({
  name: z.string().trim().min(1).max(200).meta({ example: 'Weekly review' }),
  importer: z
    .string()
    .min(1)
    .max(80)
    .describe('The importer whose rows are created (`GET /v1/data`).')
    .meta({ example: 'notes' }),
  template,
  rrule,
  startDate,
  time,
  timezone: timezone
    .optional()
    .describe("Default: your own time zone, else the server's (APP_TIMEZONE)."),
  calendarId: calendarId.optional(),
});
export type CreateRecordScheduleDto = z.infer<
  typeof createRecordScheduleSchema
>;

/** Body of `PATCH /record-schedules/{id}`: only what is sent changes. */
export const updateRecordScheduleSchema = z.object({
  name: createRecordScheduleSchema.shape.name.optional(),
  template: template.optional(),
  rrule: rrule.optional(),
  startDate: startDate.optional(),
  time: time.optional(),
  timezone: timezone.optional(),
  calendarId: calendarId.nullable().optional(),
});
export type UpdateRecordScheduleDto = z.infer<
  typeof updateRecordScheduleSchema
>;

/** Body of `POST /record-schedules/preview`. */
export const previewRecordScheduleSchema = z.object({
  rrule,
  startDate,
  time,
  timezone: timezone.optional(),
  calendarId: calendarId.optional(),
  count: z.number().int().min(1).max(MAX_PREVIEW).default(5),
});
export type PreviewRecordScheduleDto = z.infer<
  typeof previewRecordScheduleSchema
>;

export const previewSchema = z
  .object({
    occurrences: z
      .array(z.iso.datetime())
      .describe('The next moments records would be created, from now.'),
  })
  .meta({ id: 'RecordSchedulePreview' });
