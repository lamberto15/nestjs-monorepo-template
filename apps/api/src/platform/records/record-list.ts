import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { searchFields } from '../../core/database/search.js';
import { listQuery } from '../../core/http/list-query.js';
import { searchableFields } from '../fields/fields.js';
import { fieldList } from '../fields/fields.list.js';
import { tagFilter } from '../tags/tag.list.js';
import { type RecordDeclaration, takes } from './record.js';
import type { RecordSchemas } from './record.schemas.js';

/**
 * What GET /<x> can be filtered, sorted and narrowed (`fields`) by, from
 * the declaration: the fields as their types allow, the owner, the team,
 * the dates, `?q=` with search, `?tag=` with tags, `?deleted=true` with a
 * recycle bin.
 */
export function recordList(
  declaration: RecordDeclaration,
  table: Record<string, AnyPgColumn>,
  schemas: RecordSchemas,
) {
  const range = ['gt', 'gte', 'lt', 'lte', 'between'] as const;
  return listQuery(
    {
      ...(takes(declaration, 'search') &&
        searchFields(table.search!, searchableFields(declaration.fields))),
      ...(takes(declaration, 'tags') &&
        tagFilter(declaration.subject, table.id!)),
      ...(takes(declaration, 'numbered') && {
        number: {
          column: table.number!,
          type: 'string',
          ops: ['eq', 'in', 'contains', 'startsWith'],
          sortable: true,
        },
      }),
      ...fieldList(declaration.fields, table),
      ownerId: {
        column: table.ownerId!,
        type: 'string',
        ops: ['eq'],
        ref: 'principal',
      },
      ...(declaration.team && {
        teamId: {
          column: table.teamId!,
          type: 'uuid',
          ops: ['eq', 'in', 'isNull'],
          ref: 'team',
        },
      }),
      createdAt: {
        column: table.createdAt!,
        type: 'datetime',
        ops: [...range],
        sortable: true,
      },
      updatedAt: {
        column: table.updatedAt!,
        type: 'datetime',
        ops: [...range],
        sortable: true,
      },
    },
    {
      select: Object.keys(schemas.response.shape),
      softDelete: declaration.softDelete,
    },
  );
}

export type RecordList = ReturnType<typeof recordList>;
