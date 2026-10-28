import {
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { timestamps, uuidPk } from '../../core/database/columns.js';
import { tenantColumn, tenantTable } from '../../core/tenancy/tenant-scope.js';
import type { CalendarException, WeekdayHours } from './calendar-time.js';

/**
 * A tenant's business calendar: the hours it works each weekday on the
 * wall clock of a time zone, and the dates that differ (holidays, special
 * hours). `version` counts the changes that move a deadline (hours, zone,
 * exceptions); a deadline carries the version it was computed with.
 */
export const businessCalendars = pgTable(
  'business_calendars',
  {
    id: uuidPk(),
    tenantId: tenantColumn(),
    name: text('name').notNull(),
    /** The IANA zone the hours and the exceptions' dates are in. */
    timezone: text('timezone').notNull(),
    hours: jsonb('hours').$type<WeekdayHours[]>().notNull(),
    exceptions: jsonb('exceptions')
      .$type<CalendarException[]>()
      .notNull()
      .default([]),
    version: integer('version').notNull().default(1),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('business_calendars_name_idx').on(table.tenantId, table.name),
    ...tenantTable('business_calendars', table, { referenced: true }),
  ],
).enableRLS();

export type BusinessCalendarRow = typeof businessCalendars.$inferSelect;
