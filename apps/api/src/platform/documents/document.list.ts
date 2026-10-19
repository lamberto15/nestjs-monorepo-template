import { listQuery } from '../../core/http/list-query.js';
import { recordDocumentSchema } from './document.schemas.js';
import { DOCUMENT_STATUSES, documents } from './documents.tables.js';

/** What a record's documents list can be filtered and sorted by. */
export const DOCUMENT_LIST = listQuery(
  {
    status: {
      column: documents.status,
      type: 'enum',
      values: DOCUMENT_STATUSES,
      ops: ['eq', 'in'],
    },
    template: { column: documents.source, type: 'string', ops: ['eq'] },
    language: {
      column: documents.locale,
      type: 'string',
      ops: ['eq', 'in'],
    },
    createdAt: {
      column: documents.createdAt,
      type: 'datetime',
      ops: ['gte', 'lt', 'between'],
      sortable: true,
    },
  },
  { select: Object.keys(recordDocumentSchema.shape) },
);
