import { isNotNull, isNull } from 'drizzle-orm';
import { listQuery } from '../../core/http/list-query.js';
import { notificationSchema } from './notification.schemas.js';
import { notifications } from './notifications.tables.js';

/** What GET /notifications can be filtered, sorted and narrowed by. */
export const NOTIFICATION_LIST = listQuery(
  {
    read: {
      column: notifications.readAt,
      type: 'boolean',
      ops: ['eq'],
      conditions: {
        eq: (value) =>
          value
            ? isNotNull(notifications.readAt)
            : isNull(notifications.readAt),
      },
    },
    type: { column: notifications.type, type: 'string', ops: ['eq', 'in'] },
    key: { column: notifications.key, type: 'string', ops: ['eq'] },
    readAt: {
      column: notifications.readAt,
      type: 'datetime',
      ops: ['gt', 'gte', 'lt', 'lte', 'between', 'isNull'],
      sortable: true,
    },
    createdAt: {
      column: notifications.createdAt,
      type: 'datetime',
      ops: ['gt', 'gte', 'lt', 'lte', 'between'],
      sortable: true,
    },
    updatedAt: {
      column: notifications.updatedAt,
      type: 'datetime',
      ops: ['gt', 'gte', 'lt', 'lte', 'between'],
      sortable: true,
    },
  },
  { select: Object.keys(notificationSchema.shape) },
);
