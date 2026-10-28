import { listQuery } from '../../core/http/list-query.js';
import {
  automationRuleSchema,
  automationRunSchema,
} from './automation.schemas.js';
import { automationRules, automationRuns } from './automations.tables.js';

/** What GET /automation-rules can be filtered and sorted by. */
export const AUTOMATION_RULE_LIST = listQuery(
  {
    subject: {
      column: automationRules.subject,
      type: 'string',
      ops: ['eq', 'in'],
    },
    status: {
      column: automationRules.status,
      type: 'string',
      ops: ['eq', 'in'],
    },
    name: {
      column: automationRules.name,
      type: 'string',
      ops: ['eq', 'contains'],
      sortable: true,
    },
    updatedAt: {
      column: automationRules.updatedAt,
      type: 'datetime',
      ops: ['gt', 'gte', 'lt', 'lte', 'between'],
      sortable: true,
    },
  },
  { select: Object.keys(automationRuleSchema.shape) },
);

/** What GET /automation-rules/{id}/runs can be filtered by: newest first. */
export const AUTOMATION_RUN_LIST = listQuery(
  {
    status: {
      column: automationRuns.status,
      type: 'string',
      ops: ['eq'],
    },
    recordId: {
      column: automationRuns.recordId,
      type: 'uuid',
      ops: ['eq'],
    },
    createdAt: {
      column: automationRuns.createdAt,
      type: 'datetime',
      ops: ['gt', 'gte', 'lt', 'lte', 'between'],
    },
  },
  { select: Object.keys(automationRunSchema.shape) },
);
