#!/usr/bin/env node
// Compares a load-test baseline (loadtest/scenarios.js' BASELINE_FILE) with
// two references, and fails on a regression of FACTOR (2×) or more against
// either (docs/development.md, "Load tests"):
//
// - the previous successful run (a sudden regression);
// - the anchor: the run last accepted with `record_only`, or the first
//   baseline (a slow creep, 1.9× a run, that the previous run never sees).
//
//   node loadtest/compare.mjs --current results/baseline.json \
//     [--previous previous/baseline.json] [--anchor anchor/baseline.json] \
//     [--summary "$GITHUB_STEP_SUMMARY"] [--report-only]
//
// A scenario regresses when, against a reference with the same load (rate,
// phase length, and the api replicas; a baseline without `replicas` ran two.
// The bot check (`captcha`) is not part of the load: a run with it on,
// compared with one off, shows its cost (run with --report-only):
// - its median or p95 reached FACTOR times the reference's and grew by at
//   least MIN_DELTA_MS (a 3 ms route taking 7 ms is a runner's noise);
// - an export's time to a ready file (`readyMs`) is held to the same bar;
// - its failed share reached FACTOR times the reference's and at least
//   MIN_FAILED_RATE (0.5%);
// - its dropped iterations (k6 couldn't start a request on time: the stack
//   is saturated) reached FACTOR times the reference's and at least
//   MIN_DROPPED_SHARE (0.5%) of the requests due.
// A missing reference (the first run, an expired artifact) compares nothing.
// Exit 1 on a regression, 2 on bad input (arguments, an unreadable file).
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { fileRoots, within } from '../tools/cli-paths.mjs';

export const FACTOR = 2;
export const MIN_DELTA_MS = 20;
export const MIN_FAILED_RATE = 0.005;
export const MIN_DROPPED_SHARE = 0.005;
const STATS = ['med', 'p95'];

const grew = (before, now, factor, floor) =>
  typeof before === 'number' && typeof now === 'number' && now >= floor && now >= before * factor && now > before;

/** One reference: a row per scenario of `current`. */
export function compare(current, reference, { factor = FACTOR, minDeltaMs = MIN_DELTA_MS } = {}) {
  const rows = [];
  for (const [name, now] of Object.entries(current.scenarios)) {
    const before = reference?.scenarios?.[name];
    const row = { name, now, before, regressions: [], note: '' };
    if (!before) {
      row.note = reference ? 'new scenario: recorded' : 'no reference: recorded';
    } else if (
      before.rate !== now.rate ||
      reference.phaseSeconds !== current.phaseSeconds ||
      (reference.replicas ?? 2) !== (current.replicas ?? 2)
    ) {
      row.note = 'load changed: not compared';
    } else {
      for (const stat of STATS) {
        const a = before.ms[stat];
        const b = now.ms[stat];
        if (typeof a === 'number' && typeof b === 'number' && a > 0 && b >= a * factor && b - a >= minDeltaMs) {
          row.regressions.push(`${stat} ${a} → ${b} ms (×${(b / a).toFixed(2)})`);
        }
      }
      for (const stat of STATS) {
        const a = before.readyMs?.[stat];
        const b = now.readyMs?.[stat];
        if (typeof a === 'number' && typeof b === 'number' && a > 0 && b >= a * factor && b - a >= minDeltaMs) {
          row.regressions.push(`ready ${stat} ${a} → ${b} ms (×${(b / a).toFixed(2)})`);
        }
      }
      if (grew(before.failedRate ?? 0, now.failedRate ?? 0, factor, MIN_FAILED_RATE)) {
        row.regressions.push(`failed ${pct(before.failedRate ?? 0)} → ${pct(now.failedRate)}`);
      }
      const due = now.rate * current.phaseSeconds;
      if (grew(before.droppedIterations ?? 0, now.droppedIterations ?? 0, factor, Math.max(1, due * MIN_DROPPED_SHARE))) {
        row.regressions.push(`dropped ${before.droppedIterations ?? 0} → ${now.droppedIterations}`);
      }
    }
    rows.push(row);
  }
  return { rows, regressed: rows.some((row) => row.regressions.length > 0) };
}

const pct = (rate) => `${(rate * 100).toFixed(1)}%`;
const ratio = (b, a) => (typeof a === 'number' && typeof b === 'number' && a > 0 ? ` (×${(b / a).toFixed(2)})` : '');
const describe = (run) => `${run.finishedAt}${run.commit ? ` (\`${run.commit.slice(0, 12)}\`)` : ''}`;

/** One reference's table, in the job summary's Markdown. */
export function markdown(result, title, reference) {
  const lines = [
    `### ${title}`,
    '',
    reference
      ? `The run of ${describe(reference)} (${reference.replicas ?? 2} api replicas, bot check ${reference.captcha ?? 'off'}).`
      : 'None: nothing compared.',
    '',
    '| Scenario | Rate/s | Requests | Failed | Dropped | Median ms | p95 ms | p99 ms | Verdict |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
  ];
  for (const row of result.rows) {
    const { now, before } = row;
    const ready = now.readyMs ? `; ready: median ${now.readyMs.med} ms, p95 ${now.readyMs.p95} ms` : '';
    const verdict = row.regressions.length ? `**regressed**: ${row.regressions.join('; ')}` : `${row.note || 'ok'}${ready}`;
    lines.push(
      `| ${row.name} | ${now.rate} | ${now.requests} | ${pct(now.failedRate)} | ${now.droppedIterations ?? 0} | ${now.ms.med}${ratio(now.ms.med, before?.ms.med)} | ${now.ms.p95}${ratio(now.ms.p95, before?.ms.p95)} | ${now.ms.p99} | ${verdict} |`,
    );
  }
  return `${lines.join('\n')}\n\n`;
}

/** Both references: the summary, and whether either regressed. */
export function report(current, { previous, anchor, factor = FACTOR, reportOnly = false } = {}) {
  const againstPrevious = compare(current, previous, { factor });
  const againstAnchor = compare(current, anchor, { factor });
  const text = [
    '## Load test\n\n',
    `Fails at ×${factor} (median or p95, failed share, dropped iterations) against either reference${reportOnly ? ' (report-only here)' : ''}.\n\n`,
    markdown(againstPrevious, 'Against the previous run', previous),
    markdown(againstAnchor, 'Against the anchor (the last accepted baseline)', anchor),
  ].join('');
  return { text, regressed: againstPrevious.regressed || againstAnchor.regressed };
}

export function readBaseline(path) {
  const data = JSON.parse(readFileSync(path, 'utf8'));
  if (data?.version !== 1 || typeof data.scenarios !== 'object' || data.scenarios === null) {
    throw new Error(`${path} is not a load-test baseline (version 1)`);
  }
  return data;
}

const optional = (path) => (path && existsSync(path) ? readBaseline(path) : undefined);

/**
 * A file the arguments name, resolved: in this checkout or a temp directory
 * (CI: RUNNER_TEMP, which holds the step summary). Anywhere else is refused
 * (#471): Claude runs this tool too, and a wrong path must not be read or
 * appended to.
 */
function argFile(file, option) {
  if (!file) return undefined;
  const full = within(file, fileRoots());
  if (!full) throw new Error(`${option} ${file}: not under ${fileRoots().join(' or ')}`);
  return full;
}

function main() {
  let values;
  let current;
  let previous;
  let anchor;
  let summary;
  try {
    ({ values } = parseArgs({
      options: {
        current: { type: 'string' },
        previous: { type: 'string' },
        anchor: { type: 'string' },
        summary: { type: 'string' },
        'report-only': { type: 'boolean', default: false },
      },
    }));
    if (!values.current) {
      throw new Error('--current <baseline.json> is required');
    }
    current = readBaseline(argFile(values.current, '--current'));
    previous = optional(argFile(values.previous, '--previous'));
    anchor = optional(argFile(values.anchor, '--anchor'));
    summary = argFile(values.summary, '--summary');
  } catch (error) {
    console.error(`compare.mjs: ${error.message}`);
    console.error(
      'usage: compare.mjs --current <baseline.json> [--previous <baseline.json>] [--anchor <baseline.json>] [--summary <file>] [--report-only]',
    );
    process.exit(2);
  }
  const reportOnly = values['report-only'];
  const { text, regressed } = report(current, { previous, anchor, reportOnly });
  process.stdout.write(text);
  if (summary) appendFileSync(summary, text);
  if (regressed && !reportOnly) {
    console.error(`A scenario regressed ${FACTOR}× against the previous run or the anchor.`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
