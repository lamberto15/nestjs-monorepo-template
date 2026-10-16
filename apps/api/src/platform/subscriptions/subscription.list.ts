import { listQuery } from '../../core/http/list-query.js';
import { subscriptionSchema } from './subscription.schemas.js';
import { recordSubscriptions } from './subscriptions.tables.js';

/** What GET /subscriptions can be filtered and sorted by. */
export const SUBSCRIPTION_LIST = listQuery(
  {
    subject: {
      column: recordSubscriptions.subject,
      type: 'string',
      ops: ['eq', 'in'],
    },
    recordId: {
      column: recordSubscriptions.recordId,
      type: 'string',
      ops: ['eq'],
    },
    createdAt: {
      column: recordSubscriptions.createdAt,
      type: 'datetime',
      ops: ['gt', 'gte', 'lt', 'lte', 'between'],
      sortable: true,
    },
  },
  { select: Object.keys(subscriptionSchema.shape) },
);
