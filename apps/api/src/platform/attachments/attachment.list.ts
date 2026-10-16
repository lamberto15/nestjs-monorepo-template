import { listQuery } from '../../core/http/list-query.js';
import { attachmentSchema } from './attachment.schemas.js';
import { attachments } from './attachments.tables.js';

/** What a record's attachment list can be filtered and sorted by. */
export const ATTACHMENT_LIST = listQuery(
  {
    name: {
      column: attachments.name,
      type: 'string',
      ops: ['eq', 'contains'],
      sortable: true,
    },
    contentType: {
      column: attachments.contentType,
      type: 'string',
      ops: ['eq', 'in', 'startsWith'],
    },
    size: {
      column: attachments.size,
      type: 'number',
      ops: ['gte', 'lte'],
      sortable: true,
    },
    createdAt: {
      column: attachments.createdAt,
      type: 'datetime',
      ops: ['gte', 'lt', 'between'],
      sortable: true,
    },
    updatedAt: {
      column: attachments.updatedAt,
      type: 'datetime',
      ops: ['gte', 'lt', 'between'],
      sortable: true,
    },
  },
  { select: Object.keys(attachmentSchema.shape) },
);
