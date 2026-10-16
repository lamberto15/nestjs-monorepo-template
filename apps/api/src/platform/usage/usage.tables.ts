import {
  date,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { timestamps, uuidPk } from '../../core/database/columns.js';
import {
  tenantColumn,
  tenantReference,
  tenantTable,
} from '../../core/tenancy/tenant-scope.js';
import { apiClients } from '../../iam/iam.tables.js';

/**
 * API clients' requests per UTC day and route, rolled up every night from
 * the live Redis counters (UsageRollupJob). `route` is `<METHOD> <pattern>`
 * (`GET /v1/notes/{id}`); a day's total is their sum. Kept
 * USAGE_RETENTION_DAYS.
 */
export const apiUsage = pgTable(
  'api_usage',
  {
    id: uuidPk(),
    tenantId: tenantColumn(),
    clientId: uuid('client_id').notNull(),
    day: date('day').notNull(),
    route: text('route').notNull(),
    count: integer('count').notNull(),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('api_usage_client_day_route_idx').on(
      table.tenantId,
      table.clientId,
      table.day,
      table.route,
    ),
    index('api_usage_day_idx').on(table.day),
    ...tenantTable('api_usage', table),
    tenantReference(
      'api_usage_client_fk',
      [table.tenantId, table.clientId],
      [apiClients.tenantId, apiClients.id],
    ),
  ],
).enableRLS();
