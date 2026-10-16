import { listQuery } from '../../core/http/list-query.js';
import { revisionSchema } from './revision.schemas.js';
import { revisions } from './revisions.tables.js';

/** What a record's revision list can be filtered by (newest first unless `sort` says otherwise). */
export const REVISION_LIST = listQuery(
  {
    number: {
      column: revisions.number,
      type: 'number',
      ops: ['gte', 'lte', 'between'],
    },
    changedBy: {
      column: revisions.changedBy,
      type: 'string',
      ops: ['eq', 'in'],
    },
    createdAt: {
      column: revisions.createdAt,
      type: 'datetime',
      ops: ['gte', 'lt', 'between'],
      sortable: true,
    },
    updatedAt: {
      column: revisions.updatedAt,
      type: 'datetime',
      ops: ['gte', 'lt', 'between'],
      sortable: true,
    },
  },
  { select: Object.keys(revisionSchema.shape) },
);
