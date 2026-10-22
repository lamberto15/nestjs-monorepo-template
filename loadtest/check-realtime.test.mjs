import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
test('CLI returns nonzero and appends a distinct GitHub summary on failed VUs', () => {
  const folder = mkdtempSync(join(tmpdir(), 'realtime-metrics-'));
  const path = join(folder, 'report.json');
  const summary = join(folder, 'summary.md');
  writeFileSync(path, JSON.stringify(report({
    'vusers.created': 1, 'vusers.completed': 0, 'vusers.failed': 1, 'errors.Error: unauthorized': 1,
  })));
  const exe = fileURLToPath(new URL('./check-realtime.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [exe, path, summary], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(readFileSync(summary, 'utf8'), /Verdict:\*\* FAIL/);
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
