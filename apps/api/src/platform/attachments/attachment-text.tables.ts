import { type SQL, sql } from 'drizzle-orm';
import { index, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { timestamps, uuidPk } from '../../core/database/columns.js';
import { searchVector } from '../../core/database/search.js';
import {
  tenantColumn,
  tenantReference,
  tenantTable,
} from '../../core/tenancy/tenant-scope.js';
import { attachments } from './attachments.tables.js';

/**
 * `ready`: the text was extracted (it may be empty: a scanned PDF without a
 * text layer). `failed`: the extractor refused the file (too large, over its
 * time or memory limit, damaged); it is not tried again for this file.
 */
export type AttachmentTextStatus = 'ready' | 'failed';

/**
 * The text of an attachment, for the global search (ATTACHMENT_TEXT_SEARCH,
 * docs/attachments.md, "Search inside files"): extracted on a worker from the
 * file at `key`. A row whose `key` is no longer the attachment's (the file was
 * replaced) never matches and is extracted again; it goes with its attachment
 * (deleted, swept, purged by retention).
 */
export const attachmentTexts = pgTable(
  'attachment_texts',
  {
    id: uuidPk(),
    tenantId: tenantColumn(),
    attachmentId: uuid('attachment_id').notNull(),
    /** The file it was extracted from: the attachment's `key` then. */
    key: text('key').notNull(),
    status: text('status').$type<AttachmentTextStatus>().notNull(),
    /** At most `MAX_TEXT_CHARS` characters; empty when `failed`. */
    text: text('text').notNull().default(''),
    search: searchVector('search', (): SQL => sql`${attachmentTexts.text}`),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('attachment_texts_attachment_idx').on(table.attachmentId),
    index('attachment_texts_search_idx').using('gin', table.search),
    ...tenantTable('attachment_texts', table),
    tenantReference(
      'attachment_texts_attachment_fk',
      [table.tenantId, table.attachmentId],
      [attachments.tenantId, attachments.id],
    ),
  ],
).enableRLS();
