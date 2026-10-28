import { z } from 'zod';
import { listSchema } from '../../core/http/pagination.js';
import { timezone } from '../../iam/account/account.schemas.js';
import { MAX_DEADLINE_MINUTES, spansProblem } from './calendar-time.js';

/** Most calendars per tenant, and exceptions and spans per calendar. */
export const MAX_CALENDARS = 50;
export const MAX_EXCEPTIONS = 400;

const clock = z
  .string()
  .regex(/^\d{2}:\d{2}$/, { message: 'HH:MM' })
  .meta({ example: '09:00' });

const span = z.object({ start: clock, end: clock.meta({ example: '17:00' }) });

const weekdayHours = span.extend({
  weekday: z.number().int().min(0).max(6).describe('0 Sunday … 6 Saturday.'),
});

const date = z.iso.date().meta({ example: '2026-12-25' });

const exception = z
  .object({
    date: date.describe("A date in the calendar's zone."),
    name: z.string().trim().min(1).max(100).meta({ example: 'Christmas Day' }),
    hours: z
      .array(span)
      .max(10)
      .optional()
      .describe('Special hours that day; left out: closed all day.'),
  })
  .meta({ id: 'CalendarException' });

/** Hours and exceptions that make a usable calendar, else the message. */
function problem(value: {
  hours?: z.infer<typeof weekdayHours>[];
  exceptions?: z.infer<typeof exception>[];
}) {
  for (let weekday = 0; weekday < 7; weekday++) {
    const spans = (value.hours ?? []).filter((s) => s.weekday === weekday);
    const bad = spansProblem(spans);
    if (bad) return { path: 'hours', message: bad };
  }
  const seen = new Set<string>();
  for (const [index, e] of (value.exceptions ?? []).entries()) {
    const bad = e.hours ? spansProblem(e.hours) : null;
    if (bad) return { path: `exceptions.${index}.hours`, message: bad };
    if (seen.has(e.date)) {
      return {
        path: `exceptions.${index}.date`,
        message: 'A date has one exception.',
      };
    }
    seen.add(e.date);
  }
  return null;
}

const refine = (
  value: Parameters<typeof problem>[0],
  context: z.RefinementCtx,
) => {
  const found = problem(value);
  if (found) {
    context.addIssue({
      code: 'custom',
      path: found.path.split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : p)),
      message: found.message,
    });
  }
};

const hours = z
  .array(weekdayHours)
  .max(70)
  .describe(
    'The spans worked each weekday, in `timezone`; a weekday with none is closed. A span ends by 24:00 and does not cross midnight: split it over two days.',
  );
const exceptions = z.array(exception).max(MAX_EXCEPTIONS);

/** A business calendar. */
export const calendarSchema = z
  .object({
    id: z.uuid(),
    name: z.string().meta({ example: 'Support desk' }),
    timezone: z.string().meta({ example: 'Europe/Berlin' }),
    hours,
    exceptions,
    version: z
      .int()
      .describe(
        'Starts at 1; +1 whenever the hours, the zone or the exceptions change. Deadlines already computed keep their value: compare the version they carry.',
      ),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: 'BusinessCalendar' });

export const calendarListSchema = listSchema(calendarSchema).meta({
  id: 'BusinessCalendarList',
});

const name = z.string().trim().min(1).max(100);

/** Body of `POST /calendars`. */
export const createCalendarSchema = z
  .object({ name, timezone, hours, exceptions: exceptions.default([]) })
  .superRefine(refine);
export type CreateCalendarDto = z.infer<typeof createCalendarSchema>;

/** Body of `PATCH /calendars/{id}`: only what is sent changes (hours and exceptions are replaced whole). */
export const updateCalendarSchema = z
  .object({
    name: name.optional(),
    timezone: timezone.optional(),
    hours: hours.optional(),
    exceptions: exceptions.optional(),
  })
  .superRefine(refine);
export type UpdateCalendarDto = z.infer<typeof updateCalendarSchema>;

/** Body of `POST /calendars/{id}/deadline`. */
export const deadlineRequestSchema = z.object({
  from: z.iso
    .datetime({ offset: true })
    .meta({ example: '2026-10-23T14:00:00Z' }),
  minutes: z
    .number()
    .int()
    .min(0)
    .max(MAX_DEADLINE_MINUTES)
    .describe(
      'Working minutes to add; 0: the first working moment at or after `from`.',
    )
    .meta({ example: 480 }),
});
export type DeadlineRequestDto = z.infer<typeof deadlineRequestSchema>;

/** A computed deadline. */
export const deadlineSchema = z
  .object({
    due: z.iso.datetime(),
    calendarVersion: z
      .int()
      .describe(
        'The calendar version it was computed with: store it with the deadline.',
      ),
  })
  .meta({ id: 'CalendarDeadline' });
