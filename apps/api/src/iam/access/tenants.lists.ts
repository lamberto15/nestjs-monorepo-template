import { listQuery } from '../../core/http/list-query.js';
import { tenants } from '../../core/tenancy/tenancy.tables.js';

/**
 * What GET /v1/tenants (the operators') can be filtered, sorted and
 * narrowed by; GET /v1/lists/Tenant describes it. A deployment has few
 * tenants: the table is read whole by any filter, so name needs no index.
 */
export const TENANT_LIST = listQuery(
  {
    name: {
      column: tenants.name,
      type: 'string',
      ops: ['eq', 'contains', 'startsWith'],
      sortable: true,
    },
    slug: {
      column: tenants.slug,
      type: 'string',
      ops: ['eq', 'in', 'contains', 'startsWith'],
      sortable: true,
    },
    active: { column: tenants.active, type: 'boolean', ops: ['eq'] },
    operator: { column: tenants.operator, type: 'boolean', ops: ['eq'] },
    parentId: {
      column: tenants.parentId,
      type: 'uuid',
      ops: ['eq', 'isNull'],
    },
    createdAt: {
      column: tenants.createdAt,
      type: 'datetime',
      ops: ['gt', 'gte', 'lt', 'lte', 'between'],
      sortable: true,
    },
    updatedAt: {
      column: tenants.updatedAt,
      type: 'datetime',
      ops: ['gt', 'gte', 'lt', 'lte', 'between'],
      sortable: true,
    },
  },
  {
    select: [
      'id',
      'slug',
      'name',
      'active',
      'operator',
      'parentId',
      'createdAt',
      'updatedAt',
    ],
  },
);
