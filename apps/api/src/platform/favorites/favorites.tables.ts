import {
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { timestamps, uuidPk } from '../../core/database/columns.js';
import { tenantColumn, tenantTable } from '../../core/tenancy/tenant-scope.js';

/** What a favorite points at: a record, a page of the app, or a saved view. */
export const FAVORITE_KINDS = ['record', 'page', 'view'] as const;
export type FavoriteKind = (typeof FAVORITE_KINDS)[number];

/**
 * A person's favorites, in their order: the records, pages and saved views
 * they pin for quick navigation (the web app's menu). Their own alone, like
 * the records they watch (`record_subscriptions`).
 */
export const favorites = pgTable(
  'favorites',
  {
    id: uuidPk(),
    tenantId: tenantColumn(),
    /** Whose it is: `user:<id>` or `client:<id>`. */
    owner: text('owner').notNull(),
    kind: text('kind').$type<FavoriteKind>().notNull(),
    /** A record's permission subject (`Note`); empty for a page or a view. */
    subject: text('subject').notNull().default(''),
    /** The record's id, the page's path (`/notes`) or the view's id. */
    target: text('target').notNull(),
    /** The name shown in the menu, as it was when pinned. */
    label: text('label').notNull(),
    /** The place in the owner's list: lower first. */
    position: integer('position').notNull(),
    ...timestamps(),
  },
  (table) => [
    // The same thing twice in one person's favorites is refused (409).
    uniqueIndex('favorites_owner_target_idx').on(
      table.tenantId,
      table.owner,
      table.kind,
      table.subject,
      table.target,
    ),
    // One owner's list in order (GET /favorites).
    index('favorites_owner_position_idx').on(table.owner, table.position),
    ...tenantTable('favorites', table),
  ],
).enableRLS();
