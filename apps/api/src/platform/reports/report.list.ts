import { listQuery } from '../../core/http/list-query.js';
import { reportSchema } from './report.schemas.js';
import { reportSchedules } from './reports.tables.js';

/** What GET /reports can be filtered and sorted by (the caller's own, a handful). */
export const REPORT_LIST = listQuery(
  {
    exporter: {
      column: reportSchedules.exporter,
      type: 'string',
      ops: ['eq', 'in'],
    },
    active: { column: reportSchedules.active, type: 'boolean', ops: ['eq'] },
    name: {
      column: reportSchedules.name,
      type: 'string',
      ops: ['eq', 'contains'],
      sortable: true,
    },
    nextRunAt: {
      column: reportSchedules.nextRunAt,
      type: 'datetime',
      ops: ['gte', 'lt', 'between'],
      sortable: true,
    },
    createdAt: {
      column: reportSchedules.createdAt,
      type: 'datetime',
      ops: ['gt', 'gte', 'lt', 'lte', 'between'],
      sortable: true,
    },
    updatedAt: {
      column: reportSchedules.updatedAt,
      type: 'datetime',
      ops: ['gt', 'gte', 'lt', 'lte', 'between'],
      sortable: true,
    },
  },
  { select: Object.keys(reportSchema.shape) },
);
