import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { summarizeRealtime, summarizeRejectedAuthentication } from './check-realtime.mjs';

const report = (counters, summary = { p95: 95, p99: 200 }) => ({
  aggregate: { counters, summaries: { 'socketio.response_time': summary } },
});
const passing = { 'vusers.created': 3, 'vusers.completed': 3, 'vusers.failed': 0 };

test('a fully authenticated realtime scenario passes', () => {
  assert.equal(summarizeRealtime(report(passing)).ok, true);
});
test('unauthorized handshakes fail despite an Artillery zero status', () => {
  const failure = summarizeRealtime(report({
    'vusers.created': 600, 'vusers.completed': 0, 'vusers.failed': 600,
    'errors.Error: unauthorized': 600,
  }, {}));
  assert.equal(failure.ok, false);
  assert.match(failure.reasons.join('; '), /600 realtime virtual users failed/);
});
test('excess latency and missing acknowledgements fail', () => {
  assert.equal(summarizeRealtime(report(passing, { p95: 501, p99: 2001 })).ok, false);
  assert.equal(summarizeRealtime(report(passing, {})).ok, false);
});
const cli = (...args) => spawnSync(
  process.execPath,
  [fileURLToPath(new URL('./check-realtime.mjs', import.meta.url)), ...args],
  { encoding: 'utf8', input: JSON.stringify(report({
    'vusers.created': 1, 'vusers.completed': 0, 'vusers.failed': 1,
    'errors.Error: unauthorized': 1,
  })) },
);

test('CLI reads stdin and fails on unauthorized realtime VUs', () => {
  const result = cli();
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Verdict:\*\* FAIL/);
});

test('CLI validates the deliberately rejected authentication smoke test', () => {
  const result = cli('--expect-unauthorized');
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Expected rejection verdict:\*\* PASS/);
});

test('CLI rejects file path arguments instead of accessing arbitrary paths', () => {
  const result = cli('/etc/passwd');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Usage: check-realtime/);
});

test('CLI rejects invalid JSON and unexpected empty input', () => {
  const exe = fileURLToPath(new URL('./check-realtime.mjs', import.meta.url));
  for (const input of ['invalid', '']) {
    const result = spawnSync(process.execPath, [exe], { encoding: 'utf8', input });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /Cannot validate Artillery report/);
  }
});

test('negative Socket.IO smoke test needs exactly one unauthorized VU', () => {
  const unauthorized = report({
    'vusers.created': 1, 'vusers.completed': 0, 'vusers.failed': 1,
    'errors.Error: unauthorized': 1,
  }, {});
  assert.equal(summarizeRejectedAuthentication(unauthorized).ok, true);
  assert.equal(summarizeRejectedAuthentication(report(passing)).ok, false);
  assert.equal(summarizeRejectedAuthentication(report({
    'vusers.created': 1, 'vusers.completed': 0, 'vusers.failed': 1,
    'errors.Error: connect timeout': 1,
  }, {})).ok, false);
});
