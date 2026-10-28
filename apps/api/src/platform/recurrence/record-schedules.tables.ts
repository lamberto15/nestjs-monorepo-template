import { sql } from 'drizzle-orm';
import {
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { at, timestamps, uuidPk } from '../../core/database/columns.js';
import {
  tenantColumn,
  tenantReference,
  tenantTable,
} from '../../core/tenancy/tenant-scope.js';
import { businessCalendars } from '../calendars/calendars.tables.js';

export type RecordScheduleStatus = 'active' | 'paused' | 'ended';

/**
 * Recurring record schedules: a template (a row of a data importer) that
 * creates a record, as its owner, at every occurrence of an RRULE-style
 * rule in a time zone. The runner creates the due ones (`next_run_at`);
 * each occurrence is created at most once (`record_schedule_runs`).
 */
export const recordSchedules = pgTable(
  'record_schedules',
  {
    id: uuidPk(),
    tenantId: tenantColumn(),
    /** Whose schedule it is, and as whom it creates: `user:<id>` or `client:<id>`. */
    owner: text('owner').notNull(),
    name: text('name').notNull(),
    /** A DataImporter's name: `notes`. */
    importer: text('importer').notNull(),
    /** One row of that importer, as its schema takes it. */
    template: jsonb('template').$type<Record<string, unknown>>().notNull(),
    /** `FREQ=WEEKLY;BYDAY=MO;COUNT=10` (recurrence-rule.ts). */
    rrule: text('rrule').notNull(),
    startDate: date('start_date', { mode: 'string' }).notNull(),
    /** HH:MM on the wall clock of `timezone`. */
    time: text('time').notNull(),
    timezone: text('timezone').notNull(),
    /** Occurrences outside this calendar's working time move to its next working moment. */
    calendarId: uuid('calendar_id'),
    status: text('status')
      .$type<RecordScheduleStatus>()
      .notNull()
      .default('active'),
    /** Why it ended: `completed`, `ended` (by its owner), `owner_inactive`, `import_not_allowed`, `template_invalid`. */
    endReason: text('end_reason'),
    /** Occurrences handled (created, or skipped after failing for good). */
    occurrences: integer('occurrences').notNull().default(0),
    /** Stops after this many occurrences (the rule's COUNT); null: the rule's UNTIL, or never. */
    maxOccurrences: integer('max_occurrences'),
    /** Consecutive failed attempts at the occurrence due now. */
    failures: integer('failures').notNull().default(0),
    lastError: text('last_error'),
    lastRunAt: at('last_run_at'),
    /** `created` or `failed` (the last attempt). */
    lastStatus: text('last_status').$type<'created' | 'failed'>(),
    /** The occurrence due next (an exact moment: also its idempotency key); null once ended. */
    nextRunAt: at('next_run_at'),
    ...timestamps(),
  },
  (table) => [
    index('record_schedules_owner_idx').on(table.owner, table.id),
    index('record_schedules_next_run_at_idx')
      .on(table.nextRunAt)
      .where(sql`${table.status} = 'active'`),
    ...tenantTable('record_schedules', table, { referenced: true }),
    // A calendar a schedule follows can't be deleted.
    tenantReference(
      'record_schedules_calendar_fk',
      [table.tenantId, table.calendarId],
      [businessCalendars.tenantId, businessCalendars.id],
      'restrict',
    ),
  ],
).enableRLS();

export type RecordScheduleRow = typeof recordSchedules.$inferSelect;

/**
 * One row per occurrence handled: the unique `(schedule, occurrence)` is
 * what keeps a retry or a second worker from creating a record twice.
 */
export const recordScheduleRuns = pgTable(
  'record_schedule_runs',
  {
    id: uuidPk(),
    tenantId: tenantColumn(),
    scheduleId: uuid('schedule_id').notNull(),
    occurrenceAt: at('occurrence_at').notNull(),
    /** `created`, or `skipped` after failing for good. */
    status: text('status').$type<'created' | 'skipped'>().notNull(),
    error: text('error'),
    createdAt: at('created_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('record_schedule_runs_occurrence_idx').on(
      table.scheduleId,
      table.occurrenceAt,
    ),
    ...tenantTable('record_schedule_runs', table),
    tenantReference(
      'record_schedule_runs_schedule_fk',
      [table.tenantId, table.scheduleId],
      [recordSchedules.tenantId, recordSchedules.id],
      'cascade',
    ),
  ],
).enableRLS();
