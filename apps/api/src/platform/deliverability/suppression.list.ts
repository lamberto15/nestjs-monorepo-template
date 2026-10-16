import { sql } from 'drizzle-orm';
import { listQuery } from '../../core/http/list-query.js';
import { SUPPRESSION_REASONS } from '../../core/mail/mail-suppression.js';
import { mailSuppressions } from './deliverability.tables.js';
import { mailSuppressionSchema } from './suppression.schemas.js';

/** What GET /mail/suppressions can be filtered and sorted by. */
export const MAIL_SUPPRESSION_LIST = listQuery(
  {
    address: {
      column: mailSuppressions.address,
      type: 'string',
      ops: ['eq', 'contains', 'endsWith'],
      sortable: true,
      conditions: {
        // Stored lower case: a filter in any case finds it.
        eq: (value) =>
          sql`${mailSuppressions.address} = lower(${value as string})`,
      },
    },
    reason: {
      column: mailSuppressions.reason,
      type: 'enum',
      values: SUPPRESSION_REASONS,
      ops: ['eq', 'in', 'notIn'],
    },
    source: {
      column: mailSuppressions.source,
      type: 'string',
      ops: ['eq', 'in'],
    },
    suppressedAt: {
      column: mailSuppressions.suppressedAt,
      type: 'datetime',
      ops: ['gte', 'lt', 'between', 'isNull'],
      sortable: true,
    },
    lastSeenAt: {
      column: mailSuppressions.lastSeenAt,
      type: 'datetime',
      ops: ['gte', 'lt', 'between'],
      sortable: true,
    },
    createdAt: {
      column: mailSuppressions.createdAt,
      type: 'datetime',
      ops: ['gt', 'gte', 'lt', 'lte', 'between'],
      sortable: true,
    },
    updatedAt: {
      column: mailSuppressions.updatedAt,
      type: 'datetime',
      ops: ['gt', 'gte', 'lt', 'lte', 'between'],
      sortable: true,
    },
  },
  { select: Object.keys(mailSuppressionSchema.shape) },
);
