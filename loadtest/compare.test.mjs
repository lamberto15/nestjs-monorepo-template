// node --test loadtest/compare.test.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { compare, report } from './compare.mjs';

const scenario = (med, p95, rate = 10, { failedRate = 0, droppedIterations = 0 } = {}) => ({
  rate,
  requests: 600,
  failedRate,
  droppedIterations,
  ms: { avg: med, med, p90: p95, p95, p99: p95 * 1.5, max: p95 * 2 },
});
const baseline = (scenarios, extra = {}) => ({
  version: 1,
  finishedAt: '2026-10-16T02:00:00.000Z',
  commit: 'abcdef1234567890',
  phaseSeconds: 60,
  passed: true,
  scenarios,
  ...extra,
});

test('records only when there is no previous baseline', () => {
  const result = compare(baseline({ list: scenario(40, 90) }), undefined);
  assert.equal(result.regressed, false);
  assert.match(result.rows[0].note, /recorded/);
});

test('passes below twice the previous latency', () => {
  const result = compare(
    baseline({ list: scenario(79, 179) }),
    baseline({ list: scenario(40, 90) }),
  );
  assert.equal(result.regressed, false);
});

test('fails at twice the median or the p95', () => {
  const med = compare(baseline({ list: scenario(80, 100) }), baseline({ list: scenario(40, 90) }));
  assert.equal(med.regressed, true);
  assert.match(med.rows[0].regressions[0], /^med 40 → 80 ms/);
  const p95 = compare(baseline({ list: scenario(40, 200) }), baseline({ list: scenario(40, 90) }));
  assert.equal(p95.regressed, true);
  assert.match(p95.rows[0].regressions[0], /^p95 90 → 200 ms/);
});

test('ignores a doubling smaller than MIN_DELTA_MS (noise on a fast route)', () => {
  const result = compare(baseline({ list: scenario(3, 8) }), baseline({ list: scenario(1, 4) }));
  assert.equal(result.regressed, false);
});

test('does not compare a scenario whose load changed', () => {
  const rate = compare(baseline({ list: scenario(400, 900, 20) }), baseline({ list: scenario(40, 90, 10) }));
  assert.equal(rate.regressed, false);
  assert.match(rate.rows[0].note, /load changed/);
  const phase = compare(
    baseline({ list: scenario(400, 900) }, { phaseSeconds: 120 }),
    baseline({ list: scenario(40, 90) }),
  );
  assert.equal(phase.regressed, false);
});

test('a new scenario is recorded, a removed one ignored', () => {
  const result = compare(
    baseline({ list: scenario(40, 90), export: scenario(500, 900) }),
    baseline({ list: scenario(40, 90), create: scenario(60, 120) }),
  );
  assert.deepEqual(result.rows.map((row) => row.name), ['list', 'export']);
  assert.equal(result.regressed, false);
});

test('the summary names the regression and the previous run', () => {
  const current = baseline({ signIn: scenario(400, 900) });
  const previous = baseline({ signIn: scenario(150, 300) });
  const { text, regressed } = report(current, { previous });
  assert.equal(regressed, true);
  assert.match(text, /`abcdef123456`/);
  assert.match(text, /\*\*regressed\*\*: med 150 → 400 ms \(×2\.67\); p95 300 → 900 ms \(×3\.00\)/);
});

test('a slow creep fails against the anchor, though never against the previous run', () => {
  const anchor = baseline({ list: scenario(40, 90) });
  const previous = baseline({ list: scenario(70, 160) });
  const current = baseline({ list: scenario(80, 185) });
  assert.equal(compare(current, previous).regressed, false);
  const { text, regressed } = report(current, { previous, anchor });
  assert.equal(regressed, true);
  assert.match(text, /Against the anchor[\s\S]*\*\*regressed\*\*: med 40 → 80 ms/);
});

test('flags a rise in failed requests or dropped iterations (a saturated stack)', () => {
  const before = baseline({ list: scenario(40, 90) });
  const failed = compare(baseline({ list: scenario(40, 90, 10, { failedRate: 0.02 }) }), before);
  assert.match(failed.rows[0].regressions[0], /^failed 0\.0% → 2\.0%/);
  const dropped = compare(baseline({ list: scenario(40, 90, 10, { droppedIterations: 12 }) }), before);
  assert.match(dropped.rows[0].regressions[0], /^dropped 0 → 12/);
  // Below the floors (0.5% failed, 0.5% of the 600 requests due): noise.
  const noise = compare(baseline({ list: scenario(40, 90, 10, { failedRate: 0.003, droppedIterations: 2 }) }), before);
  assert.equal(noise.regressed, false);
});

test('the command exits 1 on a regression, 0 with --report-only or without a reference, 2 on bad input', () => {
  const dir = mkdtempSync(join(tmpdir(), 'loadtest-compare-'));
  const script = fileURLToPath(new URL('./compare.mjs', import.meta.url));
  const current = join(dir, 'current.json');
  const previous = join(dir, 'previous.json');
  writeFileSync(current, JSON.stringify(baseline({ list: scenario(100, 300) })));
  writeFileSync(previous, JSON.stringify(baseline({ list: scenario(40, 90) })));
  const run = (...args) => {
    try {
      execFileSync(process.execPath, [script, '--current', current, ...args], { stdio: 'pipe' });
      return 0;
    } catch (error) {
      return error.status;
    }
  };
  assert.equal(run('--previous', previous), 1);
  assert.equal(run('--previous', previous, '--report-only'), 0);
  assert.equal(run('--previous', join(dir, 'missing.json')), 0);
  assert.equal(run(), 0);
  const anchor = join(dir, 'anchor.json');
  writeFileSync(anchor, JSON.stringify(baseline({ list: scenario(40, 90) })));
  assert.equal(run('--anchor', anchor), 1);
  // Bad input: exit 2, a parse error or a wrong file alike.
  writeFileSync(previous, JSON.stringify({ not: 'a baseline' }));
  assert.equal(run('--previous', previous), 2);
  writeFileSync(previous, '{ not json');
  assert.equal(run('--previous', previous), 2);
  assert.equal(run('--unknown-flag'), 2);
});

test('holds an export to the same bar for its time to a ready file', () => {
  const exportRun = (med, p95, readyMs) => ({ ...scenario(med, p95, 1), readyMs });
  const result = compare(
    baseline({ export: exportRun(30, 60, { med: 1000, p95: 1500, max: 2000 }) }),
    baseline({ export: exportRun(30, 60, { med: 800, p95: 1500, max: 2000 }) }),
  );
  assert.equal(result.regressed, false);
  const slow = compare(
    baseline({ export: exportRun(30, 60, { med: 2000, p95: 3500, max: 4000 }) }),
    baseline({ export: exportRun(30, 60, { med: 800, p95: 1500, max: 2000 }) }),
  );
  assert.equal(slow.regressed, true);
  assert.match(slow.rows[0].regressions[0], /^ready med 800 → 2000 ms/);
});

test('does not compare runs with a different number of api replicas, but compares the bot check', () => {
  const slow = baseline({ list: scenario(200, 400) }, { replicas: 4 });
  const reference = baseline({ list: scenario(40, 90) }, { replicas: 2 });
  const replicas = compare(slow, reference);
  assert.equal(replicas.regressed, false);
  assert.match(replicas.rows[0].note, /load changed/);
  // A baseline from before `replicas` ran two.
  assert.equal(compare(baseline({ list: scenario(200, 400) }), baseline({ list: scenario(40, 90) })).regressed, true);
  assert.equal(compare(baseline({ list: scenario(200, 400) }, { replicas: 2 }), reference).regressed, true);
  // The bot check on: its cost shows as a difference.
  const captcha = compare(baseline({ list: scenario(200, 400) }, { replicas: 2, captcha: 'always' }), reference);
  assert.equal(captcha.regressed, true);
});
