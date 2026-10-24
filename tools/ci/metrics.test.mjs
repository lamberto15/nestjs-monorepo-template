import assert from 'node:assert/strict';
import { test } from 'node:test';
import { summarize, selectConfiguration } from './metrics.mjs';
const at = (n) => new Date(n * 1000).toISOString();
const run = { id: 1, created_at: at(0), conclusion: 'success' };
const job = (name, start, end, created = 0) => ({
  name,
  created_at: at(created),
  started_at: at(start),
  completed_at: at(end),
  conclusion: 'success',
});
test('runner occupancy, matrix wait, scheduling and cache evidence are separate', () => {
  const result = summarize(
    run,
    [
      job('changes', 2, 4),
      job('e2e (1/3)', 5, 65, 4),
      job('e2e (2/3)', 5, 65, 4),
      job('e2e (3/3)', 70, 130, 4),
      job('CI gate', 131, 132, 130),
    ],
    'cache hit, replaying logs\ncache miss, executing',
  );
  assert.equal(result.peakRunners, 2);
  assert.equal(result.runnerMinutes, 183 / 60);
  assert.equal(result.matrixWaitSeconds, 61);
  assert.equal(result.cacheHits, 1);
  assert.equal(result.cacheMisses, 1);
  assert.equal(result.validationMinutes, 132 / 60);
});
test('three-run medians pick lowest runner cost meeting target, else fastest', () => {
  const runs = (runnerMinutes, validationMinutes) =>
    Array.from({ length: 3 }, () => ({
      runnerMinutes,
      validationMinutes,
      conclusion: 'success',
    }));
  assert.equal(
    selectConfiguration({
      two: runs(8, 9),
      three: runs(9, 7),
      six: runs(13, 6),
    }).winner.name,
    'two',
  );
  const missed = selectConfiguration({ two: runs(8, 12), six: runs(13, 11) });
  assert.equal(missed.winner.name, 'six');
  assert.equal(missed.meetsTarget, false);
  assert.throws(() => selectConfiguration({ two: runs(1, 1).slice(0, 2) }));
});
