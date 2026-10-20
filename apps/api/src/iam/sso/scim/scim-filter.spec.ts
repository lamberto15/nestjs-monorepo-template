import { PgDialect, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { ScimException } from './scim-error.filter.js';
import { scimFilter, scimPage } from './scim-filter.js';

const people = pgTable('people', {
  id: uuid('id'),
  userName: text('user_name'),
  externalId: text('external_id'),
});
const attributes = {
  id: { column: people.id, uuid: true },
  userName: { column: people.userName, caseInsensitive: true },
  externalId: { column: people.externalId },
};
const sqlOf = (filter: string) => {
  const where = scimFilter(filter, attributes);
  return where && new PgDialect().sqlToQuery(where);
};

describe('scimFilter', () => {
  it('turns eq (joined with and) into a where clause', () => {
    expect(sqlOf('userName eq "Ada@Acme.test"')).toMatchObject({
      sql: 'lower("people"."user_name") = $1',
      params: ['ada@acme.test'],
    });
    expect(sqlOf('externalId eq "x" and USERNAME eq "a"')?.params).toEqual([
      'x',
      'a',
    ]);
  });

  it('matches nothing for an id that is no uuid (never a database error)', () => {
    expect(sqlOf('id eq "1"')?.sql).toBe('false');
  });

  it('refuses what it does not support', () => {
    for (const filter of [
      'userName co "a"',
      'userName eq "a" or userName eq "b"',
      'title eq "x"',
      'userName eq',
      'x'.repeat(1001),
    ]) {
      expect(() => scimFilter(filter, attributes)).toThrow(ScimException);
    }
    expect(scimFilter(undefined, attributes)).toBeUndefined();
  });

  it('bounds the page', () => {
    expect(scimPage()).toEqual({ offset: 0, limit: 100, startIndex: 1 });
    expect(scimPage(0, 1000)).toEqual({ offset: 0, limit: 200, startIndex: 1 });
    expect(scimPage(11, 5)).toEqual({ offset: 10, limit: 5, startIndex: 11 });
  });
});
