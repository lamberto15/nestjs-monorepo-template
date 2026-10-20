import { bigint, date, pgSchema, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { timestamps, uuidPk } from '../../core/database/columns.js';

/**
 * The platform analytics' schema (docs/tenancy.md, "Platform analytics"):
 * anonymized aggregates only, the one schema the reporting role
 * (POSTGRES_REPORTING_USER) may read (core/database/roles.ts,
 * `ensureReportingRole()`). Nothing here names a tenant, a user or a client:
 * no `tenant_id`, no other id of a row elsewhere, and the bootstrap refuses
 * a table of this schema with a `tenant_id` or `user_id` column.
 *
 * Its own schema rather than views over the tenant tables: a view reads as
 * its owner, whom FORCE ROW LEVEL SECURITY binds (it would answer nothing on
 * a managed PostgreSQL, everything where the owner is a superuser), and
 * granting the reporting role the tables themselves is what it must never
 * have. So the worker computes the aggregates under the bypass
 * (PlatformAnalyticsJob) and stores only them here.
 */
export const analytics = pgSchema('analytics');

/**
 * One figure of a day's snapshot: `metric` (`users.active`), and for a
 * breakdown its `dimension` (`tenants.by_members`: `2-10`; '' for a total).
 * `value` is null when suppressed: fewer than ANALYTICS_MIN_GROUP_SIZE, or
 * hidden so a suppressed cell can't be worked out from the others.
 */
export const platformMetrics = analytics.table(
  'platform_metrics',
  {
    id: uuidPk(),
    day: date('day').notNull(),
    metric: text('metric').notNull(),
    dimension: text('dimension').notNull().default(''),
    value: bigint('value', { mode: 'number' }),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('platform_metrics_day_metric_dimension_idx').on(
      table.day,
      table.metric,
      table.dimension,
    ),
  ],
);
