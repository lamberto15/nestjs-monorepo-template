import {
  boolean as bool,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { ApiListQuery } from './list-docs.js';
import { listQuery } from './list-query.js';

const things = pgTable('things', {
  id: uuid('id').primaryKey(),
  status: text('status').notNull(),
  rank: integer('rank').notNull(),
  done: bool('done').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
});

const LIST = listQuery(
  {
    status: {
      column: things.status,
      type: 'enum',
      values: ['draft', 'published'],
      ops: ['eq', 'in'],
      sortable: true,
    },
    rank: { column: things.rank, type: 'number', ops: ['gte'] },
    done: { column: things.done, type: 'boolean', ops: ['eq'] },
    createdAt: { column: things.createdAt, type: 'datetime', ops: ['gte'] },
  },
  { select: ['id', 'status', 'rank'] },
);

class Routes {
  list() {}
}
// What a controller's `@ApiListQuery(LIST)` does to its route.
ApiListQuery(LIST)(
  Routes.prototype,
  'list',
  Object.getOwnPropertyDescriptor(Routes.prototype, 'list')!,
);

/** The query parameters Swagger documents for the route, by name. */
function documented() {
  const parameters: {
    name: string;
    in: string;
    required: boolean;
    description?: string;
    schema: Record<string, unknown>;
  }[] = Reflect.getMetadata('swagger/apiParameters', Routes.prototype.list);
  return Object.fromEntries(parameters.map((param) => [param.name, param]));
}

describe('ApiListQuery', () => {
  it('has a parameter for every key of the list, none required', () => {
    const params = documented();
    expect(Object.keys(params).sort()).toEqual(
      [...Object.keys(LIST.shape)].sort(),
    );
    for (const param of Object.values(params)) {
      expect(param).toMatchObject({ in: 'query', required: false });
    }
  });

  it('types the page from its schema: integers with their bounds and default', () => {
    const params = documented();
    expect(params.limit.schema).toEqual({
      type: 'integer',
      minimum: 1,
      maximum: 100,
      default: 50,
    });
    // `.int()`'s safe-integer upper bound is noise.
    expect(params.page.schema).toEqual({ type: 'integer', minimum: 1 });
    expect(params.cursor.schema).toMatchObject({ type: 'string' });
    expect(params.count.schema).toEqual({
      type: 'string',
      enum: ['true', 'false'],
      default: 'false',
    });
  });

  it('types the flat filters: enums with their values, numbers, booleans, date-times', () => {
    const params = documented();
    expect(params.status.schema).toEqual({
      type: 'string',
      enum: ['draft', 'published'],
    });
    // `in` is a comma-separated string.
    expect(params['status.in'].schema).toEqual({ type: 'string' });
    expect(params['rank.gte'].schema).toMatchObject({ type: 'number' });
    expect(params.done.schema).toEqual({
      type: 'string',
      enum: ['true', 'false'],
    });
    // The format says it: no regular expression beside it.
    expect(params['createdAt.gte'].schema).toEqual({
      type: 'string',
      format: 'date-time',
    });
  });

  it('keeps the descriptions on the parameter, not in the schema', () => {
    const params = documented();
    expect(params.limit.description).toBeUndefined();
    expect(params.status.description).toBe('Filter: status =');
    expect(params.count.description).toContain('total');
    expect(params.status.schema).not.toHaveProperty('description');
    expect(params.lang.description).toBe('The language of the answer.');
  });
});
