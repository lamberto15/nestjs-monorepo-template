// Independent realtime verdict: Artillery's exit code/ensure alone has
// reported success with 600 refused Socket.IO virtual users.
import { appendFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function summarizeRealtime(report) {
  const aggregate = report?.aggregate ?? report?.metrics ?? report;
  const counters = aggregate?.counters ?? {};
  const summaries = aggregate?.summaries ?? aggregate?.histograms ?? {};
  const created = Number(counters['vusers.created'] ?? 0);
  const completed = Number(counters['vusers.completed'] ?? 0);
  const failed = Number(counters['vusers.failed'] ?? 0);
  const errors = Object.entries(counters)
    .filter(([key, value]) => key.startsWith('errors.') && Number(value) > 0);
  const response = summaries['socketio.response_time'] ?? {};
  const p95 = Number(response.p95);
  const p99 = Number(response.p99);
  const reasons = [];
  if (!created) reasons.push('No realtime virtual users were created');
  if (failed > 0) reasons.push(`${failed} realtime virtual users failed`);
  if (created !== completed) reasons.push(`Completed ${completed} of ${created} virtual users`);
  if (errors.length) reasons.push('Artillery recorded realtime errors');
  if (!Number.isFinite(p95) || !Number.isFinite(p99)) {
    reasons.push('Socket.IO acknowledgement latency metrics are missing');
  } else {
    if (p95 > 500) reasons.push(`Socket.IO p95 ${p95} ms exceeds 500 ms`);
    if (p99 > 2000) reasons.push(`Socket.IO p99 ${p99} ms exceeds 2000 ms`);
  }
  return { ok: reasons.length === 0, created, completed, failed, errors, p95, p99, reasons };
}
export function summarizeRejectedAuthentication(report) {
  const aggregate = report?.aggregate ?? report?.metrics ?? report;
  const counters = aggregate?.counters ?? {};
  const created = Number(counters['vusers.created'] ?? 0);
  const completed = Number(counters['vusers.completed'] ?? 0);
  const failed = Number(counters['vusers.failed'] ?? 0);
  const unauthorized = Object.entries(counters).filter(
    ([key, count]) => key.startsWith('errors.') && /unauthorized/i.test(key) && Number(count) > 0,
  );
  const otherErrors = Object.entries(counters).filter(
    ([key, count]) => key.startsWith('errors.') && !/unauthorized/i.test(key) && Number(count) > 0,
  );
  const count = unauthorized.reduce((sum, [, n]) => sum + Number(n), 0);
  const ok = created === 1 && completed === 0 && failed === 1 && count === 1 && otherErrors.length === 0;
  return {
    ok, created, completed, failed, errors: [...unauthorized, ...otherErrors],
    p95: NaN, p99: NaN,
    reasons: ok ? ['Invalid Socket.IO handshake rejected as expected'] :
      ['Expected exactly one unauthorized failed virtual user and no other errors'],
  };
}
const clean = (value) => String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
export function markdownRealtime(summary) {
  return [
    '## Realtime Socket.IO load test',
    '',
    `**Verdict:** ${summary.ok ? 'PASS' : 'FAIL'} (independent from HTTP k6 baseline)`,
    '',
    '| Metric | Value |',
    '| --- | ---: |',
    `| VUs created | ${summary.created} |`,
    `| VUs completed | ${summary.completed} |`,
    `| VUs failed | ${summary.failed} |`,
    `| whoami acknowledgement p95 (ms) | ${Number.isFinite(summary.p95) ? summary.p95 : 'missing'} |`,
    `| whoami acknowledgement p99 (ms) | ${Number.isFinite(summary.p99) ? summary.p99 : 'missing'} |`,
    ...summary.errors.map(([key, n]) => `| ${clean(key)} | ${n} |`),
    '',
    ...summary.reasons.map(reason => `- ${clean(reason)}`),
    '',
  ].join('\n');
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [, , reportPath, summaryPath, mode] = process.argv;
  let summary;
  try {
    if (!reportPath) throw new Error('Artillery JSON report path was not supplied');
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    summary = mode === '--expect-unauthorized'
      ? summarizeRejectedAuthentication(report) : summarizeRealtime(report);
  } catch (error) {
    summary = { ok: false, created: 0, completed: 0, failed: 0, errors: [], p95: NaN, p99: NaN,
      reasons: [`Cannot validate Artillery report: ${error.message}`] };
  }
  const md = mode === '--expect-unauthorized'
    ? markdownRealtime(summary).replace('## Realtime Socket.IO load test', '## Realtime rejected-auth smoke test')
      .replace('**Verdict:**', '**Expected rejection verdict:**')
    : markdownRealtime(summary);
  process.stdout.write(md + '\n');
  if (summaryPath) appendFileSync(summaryPath, md + '\n', 'utf8');
  if (!summary.ok) process.exitCode = 1;
}
