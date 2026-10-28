// The notification-storm soak (docs/development.md, "Load tests", #618): not
// part of the baseline nor of CI's default runs. One virtual user, against a
// load-test stack (loadtest/run.sh soak):
//
//   1. the deployment's daily mail budget set to SOAK_MAIL_LIMIT (100, a
//      provider's free quota) through the operators' setting;
//   2. SOAK_NOTES (100,000) notes imported as one JSON file: the worker
//      writes them in groups and each group is published at once
//      (NoteBatchPublicationWorkflow), the bulk path of the incident;
//   3. the outbox and the queues watched (GET /v1/ops/outbox, /v1/ops/queues)
//      every 10 s until the outbox has drained or SOAK_MINUTES (30) passed,
//      with /health asked each time.
//
// It fails when the import doesn't complete, the API stops answering, the
// mail queue holds more than SOAK_MAX_MAIL (500) jobs at once, the outbox
// dead-letters anything, or the outbox hasn't drained in time. run.sh
// samples Redis' used memory and the containers' meanwhile and checks
// SOAK_REDIS_MAX_MB. The summary goes to SOAK_FILE (soak.json).
import { fail, sleep } from 'k6';
import http from 'k6/http';
import { Counter, Rate, Trend } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://caddy';
const ADMIN_EMAIL = __ENV.ADMIN_EMAIL;
const ADMIN_PASSWORD = __ENV.ADMIN_PASSWORD;
const NOTES = Number(__ENV.SOAK_NOTES || 100_000);
const MAIL_LIMIT = Number(__ENV.SOAK_MAIL_LIMIT || 100);
const MAX_MAIL = Number(__ENV.SOAK_MAX_MAIL || 500);
const MINUTES = Number(__ENV.SOAK_MINUTES || 30);
const SOAK_FILE = __ENV.SOAK_FILE || '/out/soak.json';

export const options = {
  scenarios: {
    soak: {
      executor: 'shared-iterations',
      vus: 1,
      iterations: 1,
      maxDuration: `${MINUTES + 30}m`,
    },
  },
  // What fails the run (k6 exits non-zero).
  thresholds: {
    soak_drained: ['rate==1'],
    soak_health_failures: ['count==0'],
    soak_dead_letters: ['max==0'],
    soak_mail_queued: [`max<=${MAX_MAIL}`],
  },
};

function call(method, path, body, headers = {}) {
  return http.request(
    method,
    `${BASE_URL}${path}`,
    body === undefined ? null : JSON.stringify(body),
    {
      headers: { 'Content-Type': 'application/json', ...headers },
      responseType: 'text',
      timeout: '120s',
    },
  );
}

/** Ends the run as failed (the drained threshold fails with it). */
function stop(message) {
  drained.add(false);
  fail(message);
}

function ok(res, what, statuses = [200]) {
  if (!statuses.includes(res.status)) {
    stop(`${what}: ${res.status} ${String(res.body).slice(0, 300)}`);
  }
  return res;
}

// What handleSummary() writes (it runs apart from the VU: only metrics reach it).
const mailQueued = new Trend('soak_mail_queued');
const outboxPending = new Trend('soak_outbox_pending');
const deadLetters = new Trend('soak_dead_letters');
const lagMs = new Trend('soak_outbox_lag_ms', true);
const healthFailures = new Counter('soak_health_failures');
const drained = new Rate('soak_drained');
const importSeconds = new Trend('soak_import_seconds');

const summary = {
  notes: NOTES,
  mailLimit: MAIL_LIMIT,
  import: {},
  samples: 0,
  peaks: { mailQueued: 0, outboxPending: 0, deadLetters: 0, lagMs: 0 },
  healthFailures: 0,
  drained: false,
};

export default function () {
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    stop('ADMIN_EMAIL and ADMIN_PASSWORD are required (loadtest/run.sh sets them)');
  }
  // Only a load-test stack (its rate limits raised, as scenarios.js checks).
  const methods = http.get(`${BASE_URL}/v1/auth/methods`);
  const limit = Number(methods.headers['X-Ratelimit-Limit'] ?? methods.headers['X-RateLimit-Limit']);
  if (!(limit > 600)) stop(`${BASE_URL} isn't a load-test stack: nothing done`);

  const token = ok(
    call('POST', '/v1/auth/token', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
    'administrator sign-in',
    [200, 201],
  ).json('accessToken');
  const admin = { Authorization: `Bearer ${token}` };

  // A provider's free quota, for the whole deployment (docs/notifications.md).
  ok(
    call('PUT', '/v1/settings/mail.dailyLimit/platform', { value: MAIL_LIMIT }, admin),
    'mail.dailyLimit',
  );

  const rows = [];
  for (let i = 0; i < NOTES; i++) {
    rows.push({ title: `Soak ${i}`, body: `A note of the notification soak, number ${i}.` });
  }
  const started = Date.now();
  const imported = ok(
    http.post(
      `${BASE_URL}/v1/data/imports`,
      {
        name: 'notes',
        file: http.file(JSON.stringify(rows), 'soak.json', 'application/json'),
      },
      { headers: admin, responseType: 'text', timeout: '300s' },
    ),
    'import',
    [202],
  );
  const id = imported.json('id');
  for (;;) {
    sleep(5);
    const res = ok(call('GET', `/v1/data/transfers/${id}`, undefined, admin), 'transfer');
    const status = res.json('status');
    if (status === 'completed') {
      summary.import = { seconds: (Date.now() - started) / 1000, result: res.json('result') };
      importSeconds.add(summary.import.seconds);
      break;
    }
    if (status === 'failed') stop(`import failed: ${res.body}`);
    if (Date.now() - started > MINUTES * 60_000) stop('import not completed in time');
  }

  // The fan-out: outbox and queues until the outbox has drained.
  const watching = Date.now();
  while (Date.now() - watching < MINUTES * 60_000) {
    sleep(10);
    summary.samples++;
    if (http.get(`${BASE_URL}/health`, { timeout: '10s' }).status !== 200) {
      summary.healthFailures++;
      healthFailures.add(1);
    }
    const outbox = call('GET', '/v1/ops/outbox', undefined, admin);
    const queues = call('GET', '/v1/ops/queues', undefined, admin);
    if (outbox.status !== 200 || queues.status !== 200) {
      summary.healthFailures++;
      healthFailures.add(1);
      continue;
    }
    const stats = outbox.json('stats');
    const mail = queues.json('items').find((q) => q.name === 'mail');
    const queued = mail ? mail.counts.waiting + mail.counts.delayed + mail.counts.active : 0;
    mailQueued.add(queued);
    outboxPending.add(stats.pending);
    deadLetters.add(stats.deadLetters);
    lagMs.add(stats.lagMs);
    const peaks = summary.peaks;
    peaks.mailQueued = Math.max(peaks.mailQueued, queued);
    peaks.outboxPending = Math.max(peaks.outboxPending, stats.pending);
    peaks.deadLetters = Math.max(peaks.deadLetters, stats.deadLetters);
    peaks.lagMs = Math.max(peaks.lagMs, stats.lagMs);
    if (stats.pending === 0 && queued === 0) {
      summary.drained = true;
      summary.drainSeconds = (Date.now() - watching) / 1000;
      break;
    }
  }

  drained.add(summary.drained);
  const problems = [];
  if (summary.healthFailures > 0) problems.push(`the API failed ${summary.healthFailures} check(s)`);
  if (summary.peaks.mailQueued > MAX_MAIL) {
    problems.push(`the mail queue held ${summary.peaks.mailQueued} jobs (more than ${MAX_MAIL})`);
  }
  if (summary.peaks.deadLetters > 0) problems.push(`${summary.peaks.deadLetters} outbox dead letter(s)`);
  if (!summary.drained) problems.push(`the outbox did not drain in ${MINUTES} minutes`);
  summary.problems = problems;
  if (problems.length > 0) fail(problems.join('; '));
}

export function handleSummary(data) {
  const max = (name) => data.metrics[name]?.values.max ?? 0;
  const result = {
    notes: NOTES,
    mailLimit: MAIL_LIMIT,
    importSeconds: max('soak_import_seconds'),
    peaks: {
      mailQueued: max('soak_mail_queued'),
      outboxPending: max('soak_outbox_pending'),
      deadLetters: max('soak_dead_letters'),
      outboxLagMs: max('soak_outbox_lag_ms'),
    },
    healthFailures: data.metrics.soak_health_failures?.values.count ?? 0,
    drained: (data.metrics.soak_drained?.values.rate ?? 0) === 1,
  };
  return {
    [SOAK_FILE]: JSON.stringify(result, null, 2),
    stdout: `${JSON.stringify(result, null, 2)}\n`,
  };
}
