import { sql } from 'drizzle-orm';
import {
  check,
  index,
  jsonb,
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
import { teams } from '../../iam/iam.tables.js';

/** Who sees a saved view: its owner alone, the members of a team, or the whole tenant. */
export const VIEW_VISIBILITIES = ['private', 'team', 'tenant'] as const;
export type ViewVisibility = (typeof VIEW_VISIBILITIES)[number];

/**
 * Saved views: a list's filters, sort and columns kept under a name, for
 * any list declaration (`GET /v1/lists/{subject}`). `query` holds the list
 * query's own parameters (`status`, `title.contains`, `filter`, `sort`),
 * `columns` the item fields to show (`fields=`). Both are validated against
 * the list when saved and again when applied.
 */
export const savedViews = pgTable(
  'saved_views',
  {
    id: uuidPk(),
    tenantId: tenantColumn(),
    /** The list's permission subject: `Note`. */
    subject: text('subject').notNull(),
    name: text('name').notNull(),
    visibility: text('visibility').$type<ViewVisibility>().notNull(),
    /** Whose it is: `user:<id>` or `client:<id>`; `anonymous` once its owner's account is gone. */
    owner: text('owner').notNull(),
    /** The team a `team` view is shared with; null otherwise. */
    teamId: uuid('team_id'),
    /**
     * What the name is unique within (case-insensitively, per subject): the
     * owner's key for a private view, `team:<id>`, or `tenant`.
     */
    scope: text('scope').notNull(),
    /** The list's query parameters, as its route takes them. */
    query: jsonb('query').$type<Record<string, string>>().notNull().default({}),
    /** The item fields to show, in order; null: the list's own. */
    columns: jsonb('columns').$type<string[] | null>(),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('saved_views_name_idx').on(
      table.tenantId,
      table.subject,
      table.scope,
      sql`lower(${table.name})`,
    ),
    index('saved_views_owner_idx').on(table.owner, table.subject),
    index('saved_views_team_idx').on(table.teamId),
    check(
      'saved_views_team_check',
      sql`(${table.visibility} = 'team') = (${table.teamId} is not null)`,
    ),
    check(
      'saved_views_visibility_check',
      sql`${table.visibility} in ('private', 'team', 'tenant')`,
    ),
    ...tenantTable('saved_views', table),
    // A team deleted takes its views with it.
    tenantReference(
      'saved_views_team_fk',
      [table.tenantId, table.teamId],
      [teams.tenantId, teams.id],
    ),
  ],
).enableRLS();

export type SavedViewRow = typeof savedViews.$inferSelect;
