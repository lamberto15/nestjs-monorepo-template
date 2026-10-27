import { listQuery } from '../../core/http/list-query.js';
import { sql } from 'drizzle-orm';
import { viewSchema } from './view.schemas.js';
import { savedViews, VIEW_VISIBILITIES } from './views.tables.js';

/** What GET /views can be filtered and sorted by (the views you may see). */
export const VIEW_LIST = listQuery(
  {
    subject: { column: savedViews.subject, type: 'string', ops: ['eq', 'in'] },
    visibility: {
      column: savedViews.visibility,
      type: 'enum',
      values: VIEW_VISIBILITIES,
      ops: ['eq', 'in'],
    },
    unitId: {
      column: savedViews.unitId,
      type: 'uuid',
      ops: ['eq'],
      ref: 'unit',
    },
    name: {
      column: savedViews.name,
      type: 'string',
      ops: ['eq', 'contains'],
      // Unique whatever the case: so are its filter and its order.
      sortable: true,
      sort: sql`lower(${savedViews.name})`,
      conditions: {
        eq: (value) =>
          sql`lower(${savedViews.name}) = lower(${value as string})`,
      },
    },
    createdAt: {
      column: savedViews.createdAt,
      type: 'datetime',
      ops: ['gt', 'gte', 'lt', 'lte', 'between'],
      sortable: true,
    },
    updatedAt: {
      column: savedViews.updatedAt,
      type: 'datetime',
      ops: ['gt', 'gte', 'lt', 'lte', 'between'],
      sortable: true,
    },
  },
  // `mine` and `editable` are computed per viewer, not columns.
  { select: Object.keys(viewSchema.shape) },
);
