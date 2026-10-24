// Jobs API timestamps expose scheduling delay, not the runner allocator's
// internal queue. Report dependency/matrix waits separately and label the
// remaining delay as scheduling (which includes runner queueing).
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const time = (value) => Date.parse(value);
export const median = (values) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

export function summarize(run, jobs, log = '') {
  const active = jobs.filter(
    (j) => j.conclusion !== 'skipped' && j.started_at && j.completed_at,
  );
  if (!active.length) throw new Error('No completed runner jobs');
  const intervals = active
    .flatMap((j) => [
      [time(j.started_at), 1],
      [time(j.completed_at), -1],
    ])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let occupied = 0,
    peak = 0;
  for (const [, delta] of intervals) {
    occupied += delta;
    peak = Math.max(peak, occupied);
  }
  const matrixEnd = new Map();
  const perJob = active
    .toSorted((a, b) => time(a.started_at) - time(b.started_at))
    .map((job) => {
      const group = /^(unit|e2e|template-without-notes) \(/.test(job.name)
        ? job.name.replace(/ \(.*/, '')
        : null;
      // API and web unit matrices each have their own two-slot cap.
      const matrix =
        group === 'unit'
          ? job.name.includes('api')
            ? 'unit-api'
            : 'unit-web'
          : group;
      let slot = time(run.created_at);
      if (matrix) {
        const slots = matrixEnd.get(matrix) ?? [slot, slot];
        slots.sort((a, b) => a - b);
        slot = slots.shift();
        slots.push(time(job.completed_at));
        matrixEnd.set(matrix, slots);
      }
      const created = time(job.created_at ?? run.created_at),
        started = time(job.started_at);
      return {
        name: job.name,
        runnerMinutes: (time(job.completed_at) - started) / 60000,
        createdAfterRunSeconds: (created - time(run.created_at)) / 1000,
        matrixWaitSeconds: Math.max(0, slot - created) / 1000,
        schedulingSeconds:
          Math.max(0, started - Math.max(slot, created)) / 1000,
      };
    });
  const gate = active.find((j) => j.name === 'CI gate');
  const validationEnd = gate
    ? time(gate.completed_at)
    : Math.max(...active.map((j) => time(j.completed_at)));
  return {
    runId: run.id,
    sha: run.head_sha,
    event: run.event,
    conclusion: run.conclusion,
    elapsedMinutes:
      (Math.max(...active.map((j) => time(j.completed_at))) -
        time(run.created_at)) /
      60000,
    validationMinutes: (validationEnd - time(run.created_at)) / 60000,
    runnerMinutes: perJob.reduce((sum, j) => sum + j.runnerMinutes, 0),
    peakRunners: peak,
    schedulingSeconds: perJob.reduce((sum, j) => sum + j.schedulingSeconds, 0),
    matrixWaitSeconds: perJob.reduce((sum, j) => sum + j.matrixWaitSeconds, 0),
    cacheHits: (log.match(/cache hit, replaying logs/g) ?? []).length,
    cacheMisses: (log.match(/cache miss, executing/g) ?? []).length,
    jobs: perJob,
  };
}

export function selectConfiguration(configurations) {
  const rows = Object.entries(configurations).map(([name, runs]) => {
    if (runs.length !== 3 || runs.some((r) => r.conclusion !== 'success'))
      throw new Error(`${name}: need three successful comparable runs`);
    return {
      name,
      runnerMinutes: median(runs.map((r) => r.runnerMinutes)),
      validationMinutes: median(runs.map((r) => r.validationMinutes)),
    };
  });
  const eligible = rows.filter((r) => r.validationMinutes <= 10);
  const winner = (eligible.length ? eligible : rows).toSorted((a, b) =>
    eligible.length
      ? a.runnerMinutes - b.runnerMinutes
      : a.validationMinutes - b.validationMinutes,
  )[0];
  return { winner, meetsTarget: eligible.length > 0, configurations: rows };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'select')
    console.log(
      JSON.stringify(
        selectConfiguration(JSON.parse(readFileSync(args[0], 'utf8'))),
        null,
        2,
      ),
    );
  else if (command === 'collect') {
    const [repository, id, output] = args;
    const gh = (more) =>
      execFileSync('gh', more, {
        encoding: 'utf8',
        maxBuffer: 128 * 1024 * 1024,
      });
    const run = JSON.parse(
      gh(['api', `repos/${repository}/actions/runs/${id}`]),
    );
    const pages = JSON.parse(
      gh([
        'api',
        `repos/${repository}/actions/runs/${id}/jobs?per_page=100`,
        '--paginate',
        '--slurp',
      ]),
    );
    const log = gh(['run', 'view', id, '--repo', repository, '--log']);
    const result = summarize(
      run,
      pages.flatMap((p) => p.jobs),
      log,
    );
    writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
    console.log(
      `${id}: ${result.validationMinutes.toFixed(2)} validation min, ${result.runnerMinutes.toFixed(2)} runner-min, peak ${result.peakRunners}`,
    );
  } else
    throw new Error(
      'Usage: metrics.mjs collect owner/repo run-id output.json | select configurations.json',
    );
}
