import { jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { searchFields, tsvector } from '../database/search.js';
import { fieldsRead, listQuery, queryReads } from './list-query.js';

const things = pgTable('things', {
  id: uuid('id').primaryKey(),
  status: text('status').notNull(),
  title: text('title').notNull(),
  body: text('body'),
  totalCurrency: text('total_currency'),
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
    title: {
      column: things.title,
      type: 'string',
      ops: ['contains'],
      sortable: true,
    },
    body: { column: things.body, type: 'string', ops: ['contains'] },
    // A money field's currency: its permission is the money field's.
    totalCurrency: {
      column: things.totalCurrency,
      type: 'string',
      ops: ['eq', 'in'],
      reads: ['total'],
    },
    createdAt: {
      column: things.createdAt,
      type: 'datetime',
      ops: ['gte'],
      sortable: true,
    },
  },
  { select: ['id', 'status', 'title', 'body', 'total', 'custom'] },
).extend(
  {
    'custom.region': {
      column: things.custom,
      type: 'string',
      ops: ['eq'],
      sortable: true,
    },
  },
  ['custom.region'],
);

const reads = (raw: Record<string, unknown>) =>
  [...queryReads(LIST.parse(raw))].sort();

describe('queryReads', () => {
  it('names the fields of the flat filters', () => {
    expect(reads({ status: 'draft', 'body.contains': 'x' })).toEqual([
      'body',
      'status',
    ]);
  });

  it('names the fields of the filter tree, at every depth', () => {
    const filter = JSON.stringify({
      and: [
        { field: 'status', op: 'eq', value: 'draft' },
        {
          or: [
            { field: 'title', op: 'contains', value: 'a' },
            { and: [{ field: 'body', op: 'contains', value: 'secret' }] },
          ],
        },
      ],
    });
    expect(reads({ filter })).toEqual(['body', 'status', 'title']);
  });

  it('names the sorted and the selected fields', () => {
    expect(reads({ sort: '-createdAt,title' })).toEqual(['createdAt', 'title']);
    expect(reads({ fields: 'body,total' })).toEqual(['body', 'total']);
  });

  it('maps a custom field to its own name and to custom', () => {
    expect(reads({ 'custom.region': 'eu' })).toEqual([
      'custom',
      'custom.region',
    ]);
    expect(reads({ sort: 'custom.region' })).toEqual([
      'custom',
      'custom.region',
    ]);
    expect(reads({ fields: 'custom.region' })).toEqual([
      'custom',
      'custom.region',
    ]);
  });

  it("maps a currency filter to its money field, q and rank to the search document's fields", () => {
    expect(reads({ 'totalCurrency.in': 'EUR,USD' })).toEqual(['total']);
    expect(reads({ q: 'words' })).toEqual(['body', 'title']);
    expect(reads({ sort: '-rank' })).toEqual(['body', 'title']);
  });

  it('names nothing for paging alone, and fails closed for a query it did not validate', () => {
    expect(reads({ limit: '10', count: 'true' })).toEqual([]);
    expect(() => queryReads({ limit: 10, status: 'draft' })).toThrow(
      /listQuery\(\) validated/,
    );
    // A copy loses what the check reads: it throws too, never passes.
    expect(() =>
      queryReads({ ...LIST.parse({ 'body.contains': 'x' }) }),
    ).toThrow();
  });

  it('keeps them out of the query: not a key, nor in its JSON', () => {
    const query = LIST.parse({ 'body.contains': 'x' });
    expect(Object.keys(query)).not.toContain('reads');
    expect(JSON.parse(JSON.stringify({ ...query }))).toEqual(
      JSON.parse(JSON.stringify(query)),
    );
    expect(queryReads(query)).toEqual(['body']);
  });

  it('still builds the condition of a filter tree', () => {
    const query = LIST.parse({
      filter: JSON.stringify({ field: 'body', op: 'contains', value: 'x' }),
    });
    expect(LIST.where(query)).toBeDefined();
  });
});

describe('fieldsRead', () => {
  it("is a field's reads, else its name; a dotted name also its object field", () => {
    expect(fieldsRead(LIST.fields, 'title')).toEqual(['title']);
    expect(fieldsRead(LIST.fields, 'totalCurrency')).toEqual(['total']);
    expect(fieldsRead(LIST.fields, 'q')).toEqual(['title', 'body']);
    expect(fieldsRead(LIST.fields, 'custom.region')).toEqual([
      'custom.region',
      'custom',
    ]);
    // Not a list field (a `fields=` name): its own name.
    expect(fieldsRead(LIST.fields, 'total')).toEqual(['total']);
  });
});
