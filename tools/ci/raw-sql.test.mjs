import assert from 'node:assert/strict';
import { test } from 'node:test';
import { check, compare, countRaw } from './raw-sql.mjs';

test('the API holds only the raw SQL the allowlist grants', () => {
  assert.deepEqual(check(), []);
});

test('whole statements, sql.raw and driver queries count', () => {
  assert.equal(countRaw('await tx.execute(sql`delete from notes`);'), 1);
  assert.equal(
    countRaw('db.execute<{ id: string }>(\n  sql`select uuidv7() as id`,\n)'),
    1,
  );
  assert.equal(countRaw("sql.raw(`'simple'`)"), 1);
  assert.equal(countRaw("await client.query('begin');"), 1);
  assert.equal(countRaw('pool.query<{ n: number }>(text, values)'), 1);
});

test('builder queries and sql fragments inside them do not', () => {
  for (const source of [
    'await tx.update(notes).set({ count: sql`${notes.count} + 1` });',
    'db.select().from(tags).orderBy(asc(sql`lower(${tags.name})`));',
    'await this.bulkhead.execute(() => hash(password));',
    'const result = await this.bulk.execute(path, body);',
    "queryClient.fetchQuery({ queryKey: ['me'] });",
  ]) {
    assert.equal(countRaw(source), 0, source);
  }
});

test('more than allowed, less than allowed and gone all fail', () => {
  const allowed = { 'a.ts': { count: 1 }, 'b.ts': { count: 2 } };
  assert.deepEqual(compare({ 'a.ts': 1, 'b.ts': 2 }, allowed), []);
  assert.match(compare({ 'a.ts': 2, 'b.ts': 2 }, allowed)[0], /^a\.ts: 2 raw/);
  assert.match(compare({ 'a.ts': 1, 'b.ts': 1 }, allowed)[0], /lower it/);
  assert.match(compare({ 'b.ts': 2 }, allowed)[0], /remove it/);
  assert.match(
    compare({ 'a.ts': 1, 'b.ts': 2, 'c.ts': 1 }, allowed)[0],
    /^c\.ts: 1 raw SQL \(allowed 0\)/,
  );
});
