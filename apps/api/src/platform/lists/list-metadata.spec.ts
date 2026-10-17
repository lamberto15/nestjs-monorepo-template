import {
  boolean,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { searchFields, tsvector } from '../../core/database/search.js';
import { fieldsRead, listQuery } from '../../core/http/list-query.js';
import { customFilterFields } from '../custom-fields/custom-field.list.js';
import type { CustomFieldDefinition } from '../custom-fields/custom-field.types.js';
import { LIST_LIMITS, listMetadata } from './list-metadata.js';

const things = pgTable('things', {
  id: uuid('id').primaryKey(),
  status: text('status').notNull(),
  title: text('title').notNull(),
  body: text('body'),
  done: boolean('done').notNull(),
  custom: jsonb('custom').notNull(),
  search: tsvector('search'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
});

const LIST = listQuery(
  {
    ...searchFields(things.search, ['title', 'body']),
    status: {
      column: things.status,
      type: 'enum',
      values: ['draft', 'published'],
      ops: ['eq', 'in'],
      sortable: true,
    },
    title: { column: things.title, type: 'string', ops: ['contains'] },
    body: { column: things.body, type: 'string', ops: ['contains', 'isNull'] },
    done: { column: things.done, type: 'boolean', ops: [] },
    createdAt: {
      column: things.createdAt,
      type: 'datetime',
      ops: ['gte', 'lt'],
      sortable: true,
    },
  },
  { select: ['id', 'status', 'title', 'body', 'custom'], softDelete: true },
);

const custom = (
  key: string,
  extra: Partial<CustomFieldDefinition>,
): CustomFieldDefinition => ({
  id: key,
  subject: 'Thing',
  key,
  label: `The ${key}`,
  description: null,
  type: 'text',
  options: null,
  required: false,
  defaultValue: null,
  validation: null,
  position: 0,
  filterable: false,
  sortable: false,
  active: true,
  ...extra,
});

describe('listMetadata', () => {
  it('describes the declared fields with their operators, sorts and enum options', () => {
    const metadata = listMetadata('Thing', LIST);
    expect(metadata.fields).toEqual([
      {
        name: 'status',
        type: 'enum',
        options: ['draft', 'published'],
        operators: ['eq', 'in'],
        sortable: true,
        custom: false,
      },
      {
        name: 'title',
        type: 'string',
        operators: ['contains'],
        sortable: false,
        custom: false,
      },
      {
        name: 'body',
        type: 'string',
        operators: ['contains', 'isNull'],
        sortable: false,
        custom: false,
      },
      {
        name: 'createdAt',
        type: 'datetime',
        operators: ['gte', 'lt'],
        sortable: true,
        custom: false,
      },
    ]);
    // Neither filterable nor sortable (done), and the search's own (q, rank): not fields.
    expect(metadata).toMatchObject({
      subject: 'Thing',
      select: ['id', 'status', 'title', 'body', 'custom'],
      search: true,
      defaultSort: '-createdAt',
      limits: LIST_LIMITS,
    });
  });

  it('shows the recycle bin only to those who may list it, and only when the list has one', () => {
    expect(listMetadata('Thing', LIST).recycleBin).toBe(false);
    expect(listMetadata('Thing', LIST, { recycleBin: true }).recycleBin).toBe(
      true,
    );
    const plain = listQuery({
      title: { column: things.title, type: 'string', ops: ['eq'] },
    });
    expect(listMetadata('Thing', plain, { recycleBin: true })).toMatchObject({
      recycleBin: false,
      search: false,
      defaultSort: null,
      select: [],
    });
  });

  it('leaves out what the caller may not read, from the fields and from select', () => {
    const metadata = listMetadata('Thing', LIST, {
      hidden: (name) => name === 'body',
    });
    expect(metadata.fields.map((field) => field.name)).not.toContain('body');
    expect(metadata.select).not.toContain('body');
  });

  it('offers no search when the search document reads a hidden field', () => {
    const hidden = new Set(['body']);
    const metadata = listMetadata('Thing', LIST, {
      hidden: (name) =>
        fieldsRead(LIST.fields, name).some((field) => hidden.has(field)),
    });
    expect(metadata.search).toBe(false);
    const names = metadata.fields.map((field) => field.name);
    expect(names).not.toContain('q');
    expect(names).not.toContain('rank');
  });

  it('marks the custom fields, with their labels, and keeps them out when hidden', () => {
    const { fields, select } = customFilterFields(
      [
        custom('region', {
          type: 'select',
          options: [{ value: 'eu', label: 'Europe' }],
          filterable: true,
          sortable: true,
        }),
        custom('note', {}),
      ],
      things.custom,
    );
    const extended = LIST.extend(fields, select);
    const metadata = listMetadata('Thing', extended, {
      labels: new Map([
        ['region', 'Region'],
        ['note', 'Note'],
      ]),
    });
    expect(metadata.fields.find((f) => f.name === 'custom.region')).toEqual({
      name: 'custom.region',
      type: 'enum',
      options: ['eu'],
      operators: ['eq', 'ne', 'in', 'notIn', 'isNull'],
      sortable: true,
      custom: true,
      label: 'Region',
    });
    // Neither filterable nor sortable: only picked with fields=.
    expect(metadata.fields.map((f) => f.name)).not.toContain('custom.note');
    expect(metadata.select).toEqual(
      expect.arrayContaining(['custom.region', 'custom.note']),
    );

    const hidden = listMetadata('Thing', extended, {
      hidden: (name) => name.split('.')[0] === 'custom',
    });
    expect(hidden.fields.some((f) => f.custom)).toBe(false);
    expect(hidden.select.some((name) => name.startsWith('custom'))).toBe(false);
  });
});
