import { listQuery } from '../../core/http/list-query.js';
import { formSchema, formSubmissionSchema } from './form.schemas.js';
import { FORM_STATUSES, formSubmissions, forms } from './forms.tables.js';

/** What GET /forms can be filtered and sorted by. */
export const FORM_LIST = listQuery(
  {
    slug: { column: forms.slug, type: 'string', ops: ['eq', 'in'] },
    status: {
      column: forms.status,
      type: 'enum',
      values: FORM_STATUSES,
      ops: ['eq', 'in'],
    },
    name: {
      column: forms.name,
      type: 'string',
      ops: ['eq', 'contains'],
      sortable: true,
    },
    createdAt: {
      column: forms.createdAt,
      type: 'datetime',
      ops: ['gt', 'gte', 'lt', 'lte', 'between'],
      sortable: true,
    },
    updatedAt: {
      column: forms.updatedAt,
      type: 'datetime',
      ops: ['gt', 'gte', 'lt', 'lte', 'between'],
      sortable: true,
    },
  },
  { select: Object.keys(formSchema.shape) },
);

/**
 * What GET /forms/{id}/submissions can be filtered and sorted by: who, when
 * and which version; never the answers (no query over JSONB answers).
 */
export const FORM_SUBMISSION_LIST = listQuery(
  {
    versionId: {
      column: formSubmissions.versionId,
      type: 'uuid',
      ops: ['eq', 'in'],
    },
    submittedBy: {
      column: formSubmissions.submittedBy,
      type: 'string',
      ops: ['eq', 'in'],
      ref: 'principal',
    },
    createdAt: {
      column: formSubmissions.createdAt,
      type: 'datetime',
      ops: ['gt', 'gte', 'lt', 'lte', 'between'],
      sortable: true,
    },
  },
  { select: Object.keys(formSubmissionSchema.shape) },
);
