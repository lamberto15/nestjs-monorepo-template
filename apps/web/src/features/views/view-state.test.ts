import { describe, expect, it } from 'vitest';
import type { ColumnFilterItem } from '@/lib/data-table-types';
import { listParams, type ListField } from '@/lib/list-query';
import { UnshowableView, viewState, type ViewContext } from './view-state';

const fields = [
  { name: 'title', type: 'string', operators: ['contains', 'eq'] },
  { name: 'status', type: 'enum', operators: ['eq', 'in', 'isNull'] },
  { name: 'createdAt', type: 'datetime', operators: ['lt', 'gte', 'between'] },
  { name: 'custom.region', type: 'enum', operators: ['eq', 'in'] },
] as unknown as ListField[];

const context: ViewContext = {
  filterable: {
    title: {
      variant: 'text',
      type: 'string',
      operators: ['iLike', 'eq', 'isEmpty'],
    },
    status: {
      variant: 'multiSelect',
      type: 'enum',
      operators: ['inArray', 'isEmpty', 'isNotEmpty'],
    },
    createdAt: {
      variant: 'date',
      type: 'datetime',
      operators: ['eq', 'ne', 'lt', 'gte', 'isBetween'],
    },
  },
  sortable: new Set(['title', 'createdAt']),
  fieldOperators: Object.fromEntries(fields.map((f) => [f.name, f.operators])),
};

const item = (over: Partial<ColumnFilterItem>): ColumnFilterItem => ({
  id: 'title',
  variant: 'text',
  operator: 'iLike',
  value: 'report',
  filterId: 'x-0',
  ...over,
});

describe('viewState', () => {
  // What the table saves is what applying it gives back.
  it.each([
    ['a text filter', [item({})]],
    [
      'a list',
      [
        item({
          id: 'status',
          variant: 'multiSelect',
          operator: 'inArray',
          value: ['draft', 'published'],
        }),
      ],
    ],
    [
      'an empty check',
      [
        item({
          id: 'status',
          variant: 'multiSelect',
          operator: 'isEmpty',
          value: '',
        }),
      ],
    ],
    [
      'a day (eq)',
      [
        item({
          id: 'createdAt',
          variant: 'date',
          operator: 'eq',
          value: '2026-10-17',
        }),
      ],
    ],
    [
      'a day (ne)',
      [
        item({
          id: 'createdAt',
          variant: 'date',
          operator: 'ne',
          value: '2026-10-17',
        }),
      ],
    ],
    [
      'a range of days',
      [
        item({
          id: 'createdAt',
          variant: 'date',
          operator: 'isBetween',
          value: ['2026-10-01', '2026-10-17'],
        }),
      ],
    ],
    [
      'two filters',
      [
        item({}),
        item({
          id: 'createdAt',
          variant: 'date',
          operator: 'gte',
          value: '2026-10-01',
        }),
      ],
    ],
  ])('reads back %s', (_name, filters) => {
    const params = listParams(
      {
        page: 1,
        perPage: 20,
        sorting: [{ id: 'title', desc: true }],
        filters,
        joinOperator: 'and',
        q: 'hello',
      },
      fields,
    );
    const state = viewState(params, context);
    expect(state.filters.map(({ filterId: _f, ...rest }) => rest)).toEqual(
      filters.map(({ filterId: _f, ...rest }) => rest),
    );
    expect(state.sorting).toEqual([{ id: 'title', desc: true }]);
    expect(state.q).toBe('hello');
    expect(state.joinOperator).toBe('and');
  });

  it('keeps an OR group', () => {
    const params = listParams(
      {
        page: 1,
        perPage: 20,
        sorting: [],
        filters: [item({}), item({ operator: 'eq', value: 'x' })],
        joinOperator: 'or',
      },
      fields,
    );
    expect(viewState(params, context).joinOperator).toBe('or');
  });

  it('reads the flat filters, with their operators', () => {
    const state = viewState(
      { 'title.contains': 'report', status: 'draft', sort: '-createdAt' },
      context,
    );
    expect(state.filters).toMatchObject([
      { id: 'title', operator: 'iLike', value: 'report' },
      // The status control takes lists only: an eq is a list of one.
      { id: 'status', operator: 'inArray', value: ['draft'] },
    ]);
    expect(state.sorting).toEqual([{ id: 'createdAt', desc: true }]);
  });

  it.each([
    ['an unknown field', { nope: 'x' }],
    ['a sort on a column the table lacks', { sort: 'nope' }],
    [
      'an operator the control lacks',
      {
        filter: JSON.stringify({
          and: [{ field: 'title', op: 'startsWith', value: 'a' }],
        }),
      },
    ],
    [
      'an instant that is no day',
      {
        filter: JSON.stringify({
          and: [
            {
              field: 'createdAt',
              op: 'gte',
              value: '2026-10-17T10:30:00.000Z',
            },
          ],
        }),
      },
    ],
    [
      'flat filters beside an OR group',
      {
        filter: JSON.stringify({
          or: [{ field: 'title', op: 'contains', value: 'a' }],
        }),
        status: 'draft',
      },
    ],
    ['a filter that is not JSON', { filter: '{' }],
  ])('refuses %s rather than show it wrong', (_name, params) => {
    expect(() => viewState(params, context)).toThrow(UnshowableView);
  });
});
