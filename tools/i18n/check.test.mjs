import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TREES, checkTree, compare, messagesOf } from './check.mjs';

const [web, api] = TREES;
const run = (locale, en, other, tree = web) =>
  compare(locale, messagesOf(en, tree), messagesOf(other, tree), tree);

test('the shipped catalogs are in step with English', () => {
  assert.deepEqual(TREES.flatMap(checkTree), []);
});

test('a missing and a stale key are reported', () => {
  const problems = run('de', { a: 'A', b: 'B' }, { a: 'A', c: 'C' });
  assert.deepEqual(problems, ['missing key b', 'stale key c (not in en)']);
});

test('a placeholder that differs is reported, in both syntaxes', () => {
  assert.equal(run('de', { a: 'Hi {{name}}' }, { a: 'Hallo' }).length, 1);
  assert.equal(run('de', { a: 'Hi {name}' }, { a: 'Hallo' }, api).length, 1);
  assert.deepEqual(
    run('de', { a: 'Hi {{ name }}' }, { a: 'Hallo {{name}}' }),
    [],
  );
});

test('plural forms follow the language, not English', () => {
  const en = { n_one: '{{count}} item', n_other: '{{count}} items' };
  // zh has only "other": no "_one" missing, and a "_one" is stale.
  assert.deepEqual(run('zh', en, { n_other: '{{count}} 项' }), []);
  assert.equal(
    run('zh', en, { n_one: 'x', n_other: '{{count}} 项' }).length,
    1,
  );
  // ar has six forms: all required.
  const ar = {
    n_zero: 'a',
    n_one: 'b',
    n_two: 'c',
    n_few: 'd',
    n_many: 'e',
    n_other: 'f',
  };
  assert.deepEqual(run('ar', en, ar), []);
  assert.deepEqual(run('ar', en, { n_one: 'b', n_other: 'f' }).toSorted(), [
    'n: missing plural form few',
    'n: missing plural form many',
    'n: missing plural form two',
    'n: missing plural form zero',
  ]);
});

test('the API plural objects are checked the same way', () => {
  const en = { n: { one: '{count} item', other: '{count} items' } };
  assert.deepEqual(
    run('de', en, { n: { one: '{count} Eintrag', other: 'Einträge' } }, api),
    [],
  );
  assert.equal(run('de', en, { n: { other: 'Einträge' } }, api).length, 1);
});
