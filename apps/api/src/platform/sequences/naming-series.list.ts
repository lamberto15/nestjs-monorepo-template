import { listQuery } from '../../core/http/list-query.js';
import { namingSeriesSchema } from './naming-series.schemas.js';
import { namingSeries } from './naming-series.tables.js';

/** What GET /naming-series can be filtered and sorted by. */
export const NAMING_SERIES_LIST = listQuery(
  {
    subject: {
      column: namingSeries.subject,
      type: 'string',
      ops: ['eq', 'in'],
    },
    pattern: {
      column: namingSeries.pattern,
      type: 'string',
      ops: ['eq', 'contains', 'startsWith'],
      sortable: true,
    },
    isDefault: { column: namingSeries.isDefault, type: 'boolean', ops: ['eq'] },
    createdAt: {
      column: namingSeries.createdAt,
      type: 'datetime',
      ops: ['gt', 'gte', 'lt', 'lte', 'between'],
      sortable: true,
    },
  },
  { select: Object.keys(namingSeriesSchema.shape) },
);
