import { sql } from 'drizzle-orm';
import { boolean, index, jsonb, pgTable, text } from 'drizzle-orm/pg-core';
import { at, timestamps, uuidPk } from '../../core/database/columns.js';
import { tenantColumn, tenantTable } from '../../core/tenancy/tenant-scope.js';
import type { ReportSchedule } from './report-time.js';

/**
 * Scheduled reports: an export (an exporter, a format, its filters) run
 * for its owner on a schedule in a time zone, its file mailed to the
 * recipients. The runner starts the due ones (`next_run_at`) every hour.
 */
export const reportSchedules = pgTable(
  'report_schedules',
  {
    id: uuidPk(),
    tenantId: tenantColumn(),
    /** Whose report it is, and as whom it runs: `user:<id>` or `client:<id>`. */
    owner: text('owner').notNull(),
    name: text('name').notNull(),
    /** A DataExporter's name: `notes`. */
    exporter: text('exporter').notNull(),
    format: text('format').notNull(),
    /** The exporter's list filters, as its list route takes them. */
    filters: jsonb('filters')
      .$type<Record<string, string>>()
      .notNull()
      .default({}),
    /** The list's order, as its route's `?sort=` spells it (`-createdAt,title`); null: newest first. */
    sort: text('sort'),
    /** The IANA zone the schedule's hours are in, and the file's dates. */
    timezone: text('timezone').notNull(),
    schedule: jsonb('schedule').$type<ReportSchedule>().notNull(),
    recipients: text('recipients').array().notNull(),
    active: boolean('active').notNull().default(true),
    lastRunAt: at('last_run_at'),
    /** The last run's transfer (`GET /v1/data/transfers/{id}`). */
    lastTransferId: text('last_transfer_id'),
    /** `completed` or `failed`, once the last run's export finished. */
    lastStatus: text('last_status').$type<'completed' | 'failed'>(),
    nextRunAt: at('next_run_at').notNull(),
    ...timestamps(),
  },
  (table) => [
    index('report_schedules_owner_idx').on(table.owner, table.id),
    index('report_schedules_next_run_at_idx')
      .on(table.nextRunAt)
      .where(sql`active`),
    ...tenantTable('report_schedules', table),
  ],
).enableRLS();

export type ReportScheduleRow = typeof reportSchedules.$inferSelect;
