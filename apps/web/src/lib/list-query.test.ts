import { describe, expect, it, vi } from 'vitest';
import type { ColumnFilterItem } from '@/lib/data-table-types';
import {
  filterSpec,
  listParams,
  toCondition,
  withListMeta,
  type ListDescription,
  type ListField,
  type ListState,
} from '@/lib/list-query';

const field = (over: Partial<ListField>): ListField => ({
  name: 'f',
  type: 'string',
  operators: [],
  sortable: true,
  custom: false,
  ...over,
});

const item = (over: Partial<ColumnFilterItem>): ColumnFilterItem => ({
  id: 'title',
  variant: 'text',
  operator: 'iLike',
  value: 'report',
  filterId: 'x',
  ...over,
});

const base: ListState = {
  page: 1,
  perPage: 20,
  sorting: [],
  filters: [],
  joinOperator: 'and',
};
const fields = [
  field({ name: 'createdAt', type: 'datetime' }),
  field({ name: 'day', type: 'date' }),
];
const filterOf = (state: Partial<ListState>) =>
  JSON.parse(listParams({ ...base, ...state }, fields).filter ?? 'null');

describe('listParams', () => {
  it('pages, counts and leaves out what is not set', () => {
    expect(listParams({ ...base, page: 3, perPage: 50 }, [])).toEqual({
      page: '3',
      limit: '50',
      count: 'true',
    });
  });

  it('sorts with - for descending', () => {
    const params = listParams(
      {
        ...base,
        sorting: [
          { id: 'createdAt', desc: true },
          { id: 'title', desc: false },
        ],
      },
      [],
    );
    expect(params.sort).toBe('-createdAt,title');
  });

  it('asks for the visible fields and the search', () => {
    const params = listParams(
      { ...base, fields: ['title', 'status'], q: 'x' },
      [],
    );
    expect(params.fields).toBe('title,status');
    expect(params.q).toBe('x');
  });

  it('maps the text, equality and list operators', () => {
    const cases: [Partial<ColumnFilterItem>, unknown][] = [
      [
        { operator: 'iLike' },
        { field: 'title', op: 'contains', value: 'report' },
      ],
      [
        { operator: 'notILike' },
        { field: 'title', op: 'notContains', value: 'report' },
      ],
      [{ operator: 'eq' }, { field: 'title', op: 'eq', value: 'report' }],
      [{ operator: 'ne' }, { field: 'title', op: 'ne', value: 'report' }],
      [
        { variant: 'multiSelect', operator: 'inArray', value: ['a', 'b'] },
        { field: 'title', op: 'in', value: ['a', 'b'] },
      ],
      [
        { variant: 'multiSelect', operator: 'notInArray', value: ['a'] },
        { field: 'title', op: 'notIn', value: ['a'] },
      ],
      [
        { operator: 'isEmpty', value: '' },
        { field: 'title', op: 'isNull', value: true },
      ],
      [
        { operator: 'isNotEmpty', value: '' },
        { field: 'title', op: 'isNull', value: false },
      ],
    ];
    for (const [over, expected] of cases) {
      expect(toCondition(item(over))).toEqual(expected);
    }
  });

  it('converts numbers, and refuses a half-typed one', () => {
    const num = { variant: 'number' as const };
    expect(toCondition(item({ ...num, operator: 'gte', value: '10' }))).toEqual(
      {
        field: 'title',
        op: 'gte',
        value: 10,
      },
    );
    expect(
      toCondition(item({ ...num, operator: 'isBetween', value: ['1', '10'] })),
    ).toEqual({ field: 'title', op: 'between', value: [1, 10] });
    expect(
      toCondition(item({ ...num, operator: 'isBetween', value: ['1', ''] })),
    ).toBeUndefined();
  });

  it('converts booleans', () => {
    expect(
      toCondition(item({ variant: 'boolean', operator: 'eq', value: 'true' })),
    ).toEqual({ field: 'title', op: 'eq', value: true });
  });

  it('turns a day into a range of instants in the local time zone', () => {
    const date = { id: 'createdAt', variant: 'date' as const };
    const start = new Date(2026, 0, 31).toISOString();
    const next = new Date(2026, 1, 1).toISOString();
    const end = new Date(new Date(2026, 1, 1).getTime() - 1).toISOString();
    const at = (
      operator: ColumnFilterItem['operator'],
      value: string | string[],
    ) => toCondition(item({ ...date, operator, value }), 'datetime');

    expect(at('eq', '2026-01-31')).toEqual({
      and: [
        { field: 'createdAt', op: 'gte', value: start },
        { field: 'createdAt', op: 'lt', value: next },
      ],
    });
    expect(at('ne', '2026-01-31')).toEqual({
      or: [
        { field: 'createdAt', op: 'lt', value: start },
        { field: 'createdAt', op: 'gte', value: next },
      ],
    });
    expect(at('lt', '2026-01-31')).toMatchObject({ op: 'lt', value: start });
    expect(at('lte', '2026-01-31')).toMatchObject({ op: 'lt', value: next });
    expect(at('gt', '2026-01-31')).toMatchObject({ op: 'gte', value: next });
    expect(at('gte', '2026-01-31')).toMatchObject({ op: 'gte', value: start });
    expect(at('isBetween', ['2026-01-31', '2026-01-31'])).toEqual({
      field: 'createdAt',
      op: 'between',
      value: [start, end],
    });
    expect(at('eq', 'not a date')).toBeUndefined();
  });

  it('keeps a calendar date a plain YYYY-MM-DD', () => {
    expect(
      toCondition(
        item({
          id: 'day',
          variant: 'date',
          operator: 'gt',
          value: '2026-01-31',
        }),
        'date',
      ),
    ).toEqual({ field: 'day', op: 'gt', value: '2026-01-31' });
  });

  it("never sends the registry's relative-to-today", () => {
    expect(
      toCondition(
        item({
          variant: 'date',
          operator: 'isRelativeToToday',
          value: '3 days',
        }),
      ),
    ).toBeUndefined();
  });

  it('joins with and / or, and skips inactive filters', () => {
    const filters = [
      item({ id: 'title', operator: 'eq', value: 'a' }),
      item({ id: 'status', variant: 'select', operator: 'eq', value: '' }),
      item({ id: 'number', operator: 'eq', value: 'N1' }),
    ];
    expect(filterOf({ filters })).toEqual({
      and: [
        { field: 'title', op: 'eq', value: 'a' },
        { field: 'number', op: 'eq', value: 'N1' },
      ],
    });
    expect(filterOf({ filters, joinOperator: 'or' }).or).toHaveLength(2);
    expect(filterOf({})).toBeNull();
  });
});

describe('filterSpec', () => {
  it('offers an enum with "in" as a multi select, with the options', () => {
    expect(
      filterSpec(
        field({
          type: 'enum',
          options: ['draft', 'published'],
          operators: ['eq', 'ne', 'in', 'notIn'],
        }),
      ),
    ).toEqual({
      variant: 'multiSelect',
      operators: ['inArray', 'notInArray'],
      options: [
        { label: 'draft', value: 'draft' },
        { label: 'published', value: 'published' },
      ],
    });
  });

  it('offers text only what the API takes', () => {
    expect(
      filterSpec(
        field({
          operators: ['contains', 'notContains', 'startsWith', 'endsWith'],
        }),
      )?.operators,
    ).toEqual(['iLike', 'notILike', 'startsWith', 'endsWith']);
    expect(
      filterSpec(field({ name: 'number', operators: ['eq', 'startsWith'] }))
        ?.operators,
    ).toEqual(['eq', 'startsWith']);
    expect(filterSpec(field({ operators: [] }))).toBeUndefined();
  });

  it("turns a field with a ref into a picker of its source's options", () => {
    const options = [{ label: 'Urgent', value: 'id-1' }];
    const refs = { tag: { options } };
    expect(
      filterSpec(
        field({
          name: 'tag',
          type: 'uuid',
          operators: ['eq', 'in'],
          ref: 'tag',
        }),
        refs,
      ),
    ).toEqual({ variant: 'multiSelect', operators: ['inArray'], options });
    expect(
      filterSpec(
        field({ name: 'labels', type: 'uuid', operators: ['eq'], ref: 'tag' }),
        refs,
      ),
    ).toEqual({ variant: 'select', operators: ['eq'], options });
    // The name says nothing: a uuid named tag without a ref stays free text.
    expect(
      filterSpec(field({ name: 'tag', type: 'uuid', operators: ['eq'] }), refs)
        ?.variant,
    ).toBe('text');
    // A ref with no source here (a record's subject) keeps its own filter.
    expect(
      filterSpec(
        field({
          name: 'invoiceId',
          type: 'uuid',
          operators: ['eq'],
          ref: 'Invoice',
        }),
        refs,
      )?.variant,
    ).toBe('text');
  });

  it('offers a searched picker for users, and a picker of teams', () => {
    const search = { key: ['people'], query: vi.fn() };
    expect(
      filterSpec(
        field({ name: 'ownerId', operators: ['eq'], ref: 'principal' }),
        { principal: { options: [], search } },
      ),
    ).toEqual({ variant: 'select', operators: ['eq'], options: [], search });
    const team = field({
      name: 'teamId',
      type: 'uuid',
      operators: ['eq', 'in', 'isNull'],
      ref: 'team',
    });
    expect(filterSpec(team, { team: { options: [] } })).toEqual({
      variant: 'multiSelect',
      operators: ['inArray', 'isEmpty', 'isNotEmpty'],
      options: [],
    });
  });

  it('offers dates the operators their conversion needs, never "relative"', () => {
    const operators = filterSpec(
      field({
        type: 'datetime',
        operators: ['gt', 'gte', 'lt', 'lte', 'between', 'isNull'],
      }),
    )?.operators;
    expect(operators).toEqual([
      'eq',
      'ne',
      'lt',
      'lte',
      'gt',
      'gte',
      'isBetween',
      'isEmpty',
      'isNotEmpty',
    ]);
    expect(operators).not.toContain('isRelativeToToday');
  });
});

describe('startsWith and endsWith', () => {
  it('map to the API operators', () => {
    expect(toCondition(item({ operator: 'startsWith', value: 'N-' }))).toEqual({
      field: 'title',
      op: 'startsWith',
      value: 'N-',
    });
    expect(toCondition(item({ operator: 'endsWith', value: '-9' }))).toEqual({
      field: 'title',
      op: 'endsWith',
      value: '-9',
    });
  });

  it('send in the filter JSON', () => {
    const params = listParams(
      {
        ...base,
        filters: [item({ operator: 'startsWith', value: 'N-' })],
      },
      fields,
    );
    expect(JSON.parse(params.filter ?? 'null')).toEqual({
      and: [{ field: 'title', op: 'startsWith', value: 'N-' }],
    });
  });
});

describe('the tag filter', () => {
  it('sends the picked tags as an in list', () => {
    expect(
      toCondition(
        item({
          id: 'tag',
          variant: 'multiSelect',
          operator: 'inArray',
          value: ['a', 'b'],
        }),
        'uuid',
      ),
    ).toEqual({ field: 'tag', op: 'in', value: ['a', 'b'] });
  });
});

describe('custom fields', () => {
  it('filter, sort and pick as custom.<key>', () => {
    const custom = field({
      name: 'custom.amount',
      type: 'number',
      operators: ['gte'],
      custom: true,
    });
    const params = listParams(
      {
        ...base,
        sorting: [{ id: 'custom.amount', desc: true }],
        fields: ['title', 'custom.amount'],
        filters: [
          item({
            id: 'custom.amount',
            variant: 'number',
            operator: 'gte',
            value: '10',
          }),
        ],
      },
      [custom],
    );
    expect(params.sort).toBe('-custom.amount');
    expect(params.fields).toBe('title,custom.amount');
    expect(JSON.parse(params.filter ?? 'null')).toEqual({
      and: [{ field: 'custom.amount', op: 'gte', value: 10 }],
    });
    expect(filterSpec(custom)).toEqual({
      variant: 'number',
      operators: ['gte'],
    });
  });
});

describe('withListMeta', () => {
  const description = {
    fields: [
      field({ name: 'title', operators: ['contains'], sortable: true }),
      field({ name: 'body', operators: [], sortable: false }),
    ],
  } as unknown as ListDescription;

  it('takes filtering and sorting from the list, labels from the caller', () => {
    const [title, body, other] = withListMeta<{ id: string }>(
      [
        { id: 'title', meta: { label: 'Title' } },
        { id: 'body' },
        { id: 'unknown' },
      ],
      description,
    );
    expect(title).toMatchObject({
      enableSorting: true,
      enableColumnFilter: true,
      meta: { label: 'Title', variant: 'text', operators: ['iLike'] },
    });
    expect(body).toMatchObject({
      enableSorting: false,
      enableColumnFilter: false,
    });
    expect(other).toMatchObject({
      enableSorting: false,
      enableColumnFilter: false,
    });
  });

  it("gives a ref column its source's options", () => {
    const options = [{ label: 'Urgent', value: 'id-1' }];
    const [tag] = withListMeta<{ id: string }>(
      [{ id: 'tag' }],
      {
        fields: [
          field({
            name: 'tag',
            type: 'uuid',
            operators: ['eq', 'in'],
            ref: 'tag',
          }),
        ],
      } as unknown as ListDescription,
      { tag: { options } },
    );
    expect(tag).toMatchObject({
      enableColumnFilter: true,
      meta: { variant: 'multiSelect', operators: ['inArray'], options },
    });
  });
});
