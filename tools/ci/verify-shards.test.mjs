import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifyMembership } from './verify-shards.mjs';
test('shard membership rejects missing, duplicate and unknown tests', () => {
  verifyMembership(['a', 'b', 'c'], [['a'], ['b', 'c']]);
  for (const shards of [
    [['a'], ['b']],
    [
      ['a', 'b'],
      ['b', 'c'],
    ],
    [['a', 'b'], ['x']],
  ])
    assert.throws(() => verifyMembership(['a', 'b', 'c'], shards));
  assert.throws(() => verifyMembership([], []));
});
