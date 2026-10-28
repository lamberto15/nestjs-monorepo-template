import { listQuery } from '../../core/http/list-query.js';
import { commentSchema } from './comment.schemas.js';
import { comments } from './comments.tables.js';

/** What a record's comment list can be filtered and sorted by (oldest first unless `sort` says otherwise). */
export const COMMENT_LIST = listQuery(
  {
    author: {
      column: comments.author,
      type: 'string',
      ops: ['eq', 'in'],
      ref: 'principal',
    },
    parentId: {
      column: comments.parentId,
      type: 'uuid',
      ops: ['eq', 'isNull'],
    },
    resolvedAt: {
      column: comments.resolvedAt,
      type: 'datetime',
      ops: ['isNull', 'gte', 'lte'],
    },
    createdAt: {
      column: comments.createdAt,
      type: 'datetime',
      ops: ['gt', 'gte', 'lt', 'lte', 'between'],
      sortable: true,
    },
    updatedAt: {
      column: comments.updatedAt,
      type: 'datetime',
      ops: ['gt', 'gte', 'lt', 'lte', 'between'],
      sortable: true,
    },
  },
  { select: Object.keys(commentSchema.shape) },
);
