import { sql } from 'drizzle-orm';
import { listQuery } from '../../core/http/list-query.js';
import { templateSchema } from './template.schemas.js';
import { recordTemplates, TEMPLATE_VISIBILITIES } from './templates.tables.js';

/** What GET /templates can be filtered and sorted by (the templates you may see). */
export const TEMPLATE_LIST = listQuery(
  {
    subject: {
      column: recordTemplates.subject,
      type: 'string',
      ops: ['eq', 'in'],
    },
    visibility: {
      column: recordTemplates.visibility,
      type: 'enum',
      values: TEMPLATE_VISIBILITIES,
      ops: ['eq', 'in'],
    },
    unitId: {
      column: recordTemplates.unitId,
      type: 'uuid',
      ops: ['eq'],
      ref: 'unit',
    },
    name: {
      column: recordTemplates.name,
      type: 'string',
      ops: ['eq', 'contains'],
      // Unique whatever the case: so are its filter and its order.
      sortable: true,
      sort: sql`lower(${recordTemplates.name})`,
      conditions: {
        eq: (value) =>
          sql`lower(${recordTemplates.name}) = lower(${value as string})`,
      },
    },
    createdAt: {
      column: recordTemplates.createdAt,
      type: 'datetime',
      ops: ['gt', 'gte', 'lt', 'lte', 'between'],
      sortable: true,
    },
    updatedAt: {
      column: recordTemplates.updatedAt,
      type: 'datetime',
      ops: ['gt', 'gte', 'lt', 'lte', 'between'],
      sortable: true,
    },
  },
  // `mine` and `editable` are computed per viewer, not columns.
  { select: Object.keys(templateSchema.shape) },
);
