import { sql } from 'drizzle-orm';
import { listQuery } from '../../core/http/list-query.js';
import { legalHoldSchema } from './legal-hold.schemas.js';
import { legalHolds } from './legal-holds.tables.js';

/** What GET /legal-holds can be filtered and sorted by. */
export const LEGAL_HOLD_LIST = listQuery(
  {
    subject: {
      column: legalHolds.subject,
      type: 'string',
      ops: ['eq', 'in'],
    },
    recordId: { column: legalHolds.recordId, type: 'uuid', ops: ['eq'] },
    active: {
      column: legalHolds.releasedAt,
      type: 'boolean',
      ops: ['eq'],
      conditions: {
        eq: (value) =>
          value
            ? sql`${legalHolds.releasedAt} is null`
            : sql`${legalHolds.releasedAt} is not null`,
      },
    },
    createdAt: {
      column: legalHolds.createdAt,
      type: 'datetime',
      ops: ['gt', 'gte', 'lt', 'lte', 'between'],
      sortable: true,
    },
  },
  { select: Object.keys(legalHoldSchema.shape) },
);
