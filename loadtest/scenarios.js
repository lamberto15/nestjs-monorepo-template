// The load-test baseline (docs/development.md, "Load tests"): four
// scenarios against the production stack, one after the other so each
// route's numbers are its own:
//
//   signIn  POST /v1/auth/sign-in            (scrypt, a session, the audit entry)
//   list    GET  /v1/notes?<filters>&sort=   (the permission filter, list query, ETag)
//   create  POST /v1/notes                   (idempotency, transaction, outbox, workflow)
//   export  POST /v1/data/exports, then GET /v1/data/transfers/{id} until the
//           file is ready                    (the queue, the worker, storage)
//
// Realtime (socket.io) is loadtest/realtime.yml, run by Artillery.
//
// Each runs at a constant arrival rate, so latency is what changes, not the
// load. setup() seeds what they need through the API: the load-test API
// client (high daily quota), the users who sign in, and notes to list.
// handleSummary() writes the baseline: BASELINE_FILE (JSON), compared with
// the previous run's by loadtest/compare.mjs.
//
// Run it with loadtest/run.sh (it starts the stack and k6's container).
import { check, fail, sleep } from 'k6';
import exec from 'k6/execution';
import http from 'k6/http';
import { Rate, Trend } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://caddy';
const ADMIN_EMAIL = __ENV.ADMIN_EMAIL;
const ADMIN_PASSWORD = __ENV.ADMIN_PASSWORD;
const BASELINE_FILE = __ENV.BASELINE_FILE || '/out/baseline.json';
// How the stack was run (loadtest/run.sh), written into the baseline: the
// api replicas behind Caddy, and the bot check (`always`: in place, with the
// stub provider; its cost is the difference to a run with it off).
const REPLICAS = Number(__ENV.REPLICAS || 2);
const CAPTCHA = __ENV.CAPTCHA || 'off';

const CLIENT_NAME = 'load-test';
const DAILY_QUOTA = 10_000_000;
const SEED_NOTES = 300;
const TITLES = ['Report', 'Meeting', 'Idea', 'Invoice'];

// One phase per scenario, a pause between them (requests in flight finish,
// the publication workflow's jobs drain).
const PHASE_SECONDS = Number(__ENV.PHASE_SECONDS || 60);
const GAP_SECONDS = 10;
const RATES = {
  // Below what two replicas hash: scrypt (N = 2^17) takes ~0.4 s of a CPU
  // and 128 MiB each, so sign-ins queued past that OOM-kill an api replica
  // (docs/development.md, "Load tests").
  signIn: Number(__ENV.SIGN_IN_RATE || 2),
  list: Number(__ENV.LIST_RATE || 50),
  create: Number(__ENV.CREATE_RATE || 20),
  // Each export reads the seeded notes (300) into a file through the queue.
  export: Number(__ENV.EXPORT_RATE || 1),
};
const SCENARIOS = ['signIn', 'list', 'create', 'export'];

// The export's own numbers: the request that starts it (202), and the time
// until the transfer reads `completed` (the worker's turn included).
const exportRequest = new Trend('export_request_ms', true);
const exportReady = new Trend('export_ready_ms', true);
const exportFailed = new Rate('export_failed');
const EXPORT_TIMEOUT_MS = 60_000;

/** 1% of the iterations due in a phase (at least one). */
function allowedDrops(name) {
  return Math.max(1, Math.floor(RATES[name] * PHASE_SECONDS * 0.01));
}

function scenario(name, index) {
  return {
    executor: 'constant-arrival-rate',
    // `export` is a reserved word: the scenario's function is exportNotes.
    exec: name === 'export' ? 'exportNotes' : name,
    rate: RATES[name],
    timeUnit: '1s',
    duration: `${PHASE_SECONDS}s`,
    startTime: `${index * (PHASE_SECONDS + GAP_SECONDS)}s`,
    preAllocatedVUs: Math.max(10, RATES[name] * 2),
    maxVUs: Math.max(50, RATES[name] * 10),
    // An export in flight is waited for, up to its timeout.
    gracefulStop: name === 'export' ? `${EXPORT_TIMEOUT_MS / 1000 + 10}s` : '10s',
  };
}

export const options = {
  setupTimeout: '5m',
  discardResponseBodies: true,
  scenarios: Object.fromEntries(
    SCENARIOS.map((name, index) => [name, scenario(name, index)]),
  ),
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max', 'count'],
  // Per scenario: the latency trend (a threshold that always holds, so the
  // summary carries the sub-metric), the errors, and the iterations k6
  // couldn't start on time (the stack saturated: the rate wasn't served). A
  // run with more than 1% of either fails, and never becomes a baseline.
  thresholds: {
    ...Object.fromEntries(
      SCENARIOS.flatMap((name) => [
        [`http_req_duration{scenario:${name}}`, ['max>=0']],
        [`http_req_failed{scenario:${name}}`, ['rate<0.01']],
        [`dropped_iterations{scenario:${name}}`, [`count<=${allowedDrops(name)}`]],
      ]),
    ),
    // The export's time to a ready file is compared like a latency (the
    // baseline); a file that never arrives, or a failed transfer, is an error.
    export_ready_ms: ['max>=0'],
    export_request_ms: ['max>=0'],
    export_failed: ['rate<0.01'],
  },
};

function request(method, path, body, headers = {}) {
  const payload = body === undefined ? null : JSON.stringify(body);
  return http.request(method, `${BASE_URL}${path}`, payload, {
    headers: { 'Content-Type': 'application/json', ...headers },
    responseType: 'text',
    tags: { name: `${method} ${path.split('?')[0]}` },
  });
}

function expect(res, statuses, what) {
  if (!statuses.includes(res.status)) {
    fail(`${what}: ${res.status} ${String(res.body).slice(0, 300)}`);
  }
  return res;
}

/**
 * The bot check's token when the stack runs it (LOADTEST_CAPTCHA=always):
 * the stub provider passes `stub:pass:` plus anything, once, so each request
 * gets its own (docs/auth.md, "Bot protection").
 */
function captchaHeaders() {
  return CAPTCHA === 'off' ? {} : { 'X-Captcha-Token': `stub:pass:${uuid()}` };
}

function uuid() {
  const hex = [];
  for (let i = 0; i < 32; i++) hex.push(Math.floor(Math.random() * 16).toString(16));
  hex[12] = '4';
  hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const h = hex.join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}


function createNote(key, title) {
  return http.post(
    `${BASE_URL}/v1/notes`,
    JSON.stringify({ title, body: `A note the load test wrote: ${title}.` }),
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
        'Idempotency-Key': uuid(),
      },
      tags: { name: 'POST /v1/notes' },
    },
  );
}

/** What the scenarios need, made through the API as an administrator would. */
export function setup() {
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    fail('ADMIN_EMAIL and ADMIN_PASSWORD are required (loadtest/run.sh sets them)');
  }
  // The stack is up when Caddy reaches a healthy replica.
  for (let i = 0; ; i++) {
    const res = http.get(`${BASE_URL}/health`, { timeout: '5s' });
    if (res.status === 200) break;
    if (i >= 90) fail(`the stack never became healthy: ${res.status}`);
    sleep(2);
  }

  // Only a load-test stack: its limits are raised (RATE_LIMIT_MULTIPLIER),
  // which a production app accepts only with APP_ENV=loadtest. Anywhere else
  // (a real deployment) setup stops before creating users or a client.
  const methods = http.get(`${BASE_URL}/v1/auth/methods`);
  const limit = Number(methods.headers['X-Ratelimit-Limit'] ?? methods.headers['X-RateLimit-Limit']);
  if (!(limit > 600)) {
    fail(`${BASE_URL} isn't a load-test stack (rate limit ${limit || 'unknown'}, not raised): nothing seeded`);
  }

  // The administrator, as a token client (no cookie over plain HTTP).
  const signedIn = expect(
    request('POST', '/v1/auth/token', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD }, captchaHeaders()),
    [200, 201],
    'administrator sign-in',
  );
  const admin = { Authorization: `Bearer ${signedIn.json('accessToken')}` };

  // The dedicated load-test API client: its key, and a high daily quota
  // (the quota path runs on every request, as for any metered client).
  let client = request('POST', '/v1/access/clients', { name: CLIENT_NAME }, admin);
  if (client.status === 409) {
    // A rerun on the same stack: a fresh key for the existing client.
    const clients = expect(request('GET', '/v1/access/clients', undefined, admin), [200], 'clients');
    const existing = clients.json('items').find((c) => c.name === CLIENT_NAME);
    client = request('POST', `/v1/access/clients/${existing.id}/rotate`, { graceSeconds: 0 }, admin);
  }
  expect(client, [200, 201], 'load-test client');
  const clientId = client.json('id');
  const key = client.json('key');
  expect(
    request('PATCH', `/v1/access/clients/${clientId}`, { dailyQuota: DAILY_QUOTA }, admin),
    [200],
    'daily quota',
  );


  // Notes to list: the client's own (what its permissions let it read).
  for (let done = 0; done < SEED_NOTES; done += 25) {
    const batch = [];
    for (let i = done; i < Math.min(done + 25, SEED_NOTES); i++) {
      batch.push([
        'POST',
        `${BASE_URL}/v1/notes`,
        JSON.stringify({ title: `${TITLES[i % TITLES.length]} ${i}`, body: `Seeded note ${i}.` }),
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${key}`,
            'Idempotency-Key': uuid(),
          },
        },
      ]);
    }
    for (const res of http.batch(batch)) expect(res, [201], 'seeded note');
  }
  return { key };
}

// The seeded administrator signs in (its tenant, its roles): an account
// only signs in once its address is proved, which a load test can't do for
// accounts of its own (invitations and sign-ups prove it by mail). One
// address at 2/s stays under its raised limit (5 × RATE_LIMIT_MULTIPLIER
// per 15 minutes).
export function signIn() {
  const res = http.post(
    `${BASE_URL}/v1/auth/sign-in`,
    JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
    {
      headers: { 'Content-Type': 'application/json', ...captchaHeaders() },
      tags: { name: 'POST /v1/auth/sign-in' },
    },
  );
  check(res, { 'signed in': (r) => r.status === 200 });
}

// Filters a list screen sends: status, a title search, a date range, sorted.
const LIST_QUERIES = [
  'status=draft&sort=-createdAt&limit=20',
  'title.contains=report&sort=-createdAt&limit=20',
  'status.in=draft,published&title.startsWith=Meeting&sort=title&limit=50',
  `createdAt.gte=${new Date(Date.now() - 86_400_000).toISOString()}&sort=-createdAt&limit=20`,
];

export function list(data) {
  const query = LIST_QUERIES[exec.scenario.iterationInTest % LIST_QUERIES.length];
  const res = http.get(`${BASE_URL}/v1/notes?${query}`, {
    headers: { Authorization: `Bearer ${data.key}` },
    tags: { name: 'GET /v1/notes' },
  });
  check(res, { listed: (r) => r.status === 200 });
}

export function create(data) {
  const n = exec.scenario.iterationInTest;
  const res = createNote(data.key, `${TITLES[n % TITLES.length]} load ${n}`);
  check(res, { created: (r) => r.status === 201 });
}

// An export of the notes the load-test client may read, as CSV: queued by the
// request, built by the worker, stored. The iteration lasts until the
// transfer is `completed` (polled every 500 ms), so `export_ready_ms` is what
// a user waits for.
export function exportNotes(data) {
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${data.key}` };
  const started = http.post(
    `${BASE_URL}/v1/data/exports`,
    JSON.stringify({ name: 'notes', format: 'csv' }),
    { headers, responseType: 'text', tags: { name: 'POST /v1/data/exports' } },
  );
  exportRequest.add(started.timings.duration);
  if (!check(started, { 'export queued': (r) => r.status === 202 })) {
    exportFailed.add(true);
    return;
  }
  const id = started.json('id');
  const begun = Date.now();
  while (Date.now() - begun < EXPORT_TIMEOUT_MS) {
    sleep(0.5);
    const res = http.get(`${BASE_URL}/v1/data/transfers/${id}`, {
      headers,
      responseType: 'text',
      tags: { name: 'GET /v1/data/transfers/{id}' },
    });
    const status = res.status === 200 ? res.json('status') : undefined;
    if (status === 'completed' && res.json('result.url')) {
      exportReady.add(Date.now() - begun);
      exportFailed.add(false);
      return;
    }
    if (status === 'failed' || (res.status !== 200 && res.status !== 404)) break;
  }
  exportFailed.add(true);
}

// --- The baseline ---------------------------------------------------------

const round = (value) => (value === undefined ? null : Math.round(value * 100) / 100);

export function handleSummary(data) {
  const metric = (name) => data.metrics[name]?.values ?? {};
  const scenarios = {};
  for (const name of SCENARIOS) {
    // The export's latency is the request that starts it (the polls are
    // waiting, not work); its time to a ready file is `readyMs`.
    const duration = metric(
      name === 'export' ? 'export_request_ms' : `http_req_duration{scenario:${name}}`,
    );
    const failed = metric(`http_req_failed{scenario:${name}}`);
    const ready = metric('export_ready_ms');
    scenarios[name] = {
      rate: RATES[name],
      requests: duration.count ?? 0,
      failedRate: round(failed.rate ?? 0),
      droppedIterations: metric(`dropped_iterations{scenario:${name}}`).count ?? 0,
      ms: {
        avg: round(duration.avg),
        med: round(duration.med),
        p90: round(duration['p(90)']),
        p95: round(duration['p(95)']),
        p99: round(duration['p(99)']),
        max: round(duration.max),
      },
      ...(name === 'export' && {
        readyMs: {
          med: round(ready.med),
          p95: round(ready['p(95)']),
          max: round(ready.max),
        },
      }),
    };
  }
  const baseline = {
    version: 1,
    finishedAt: new Date().toISOString(),
    commit: __ENV.GIT_SHA || null,
    k6: __ENV.K6_IMAGE || null,
    phaseSeconds: PHASE_SECONDS,
    replicas: REPLICAS,
    captcha: CAPTCHA,
    passed: Object.values(data.metrics).every((m) =>
      Object.values(m.thresholds ?? {}).every((t) => t.ok),
    ),
    scenarios,
  };
  const lines = [
    `${REPLICAS} api replicas, bot check ${CAPTCHA}`,
    'scenario   rate/s  requests  failed  dropped   med ms   p95 ms   p99 ms   max ms',
    ...SCENARIOS.map((name) => {
      const s = scenarios[name];
      return [
        name.padEnd(9),
        String(s.rate).padStart(7),
        String(s.requests).padStart(9),
        `${(s.failedRate * 100).toFixed(1)}%`.padStart(7),
        String(s.droppedIterations).padStart(8),
        String(s.ms.med).padStart(8),
        String(s.ms.p95).padStart(8),
        String(s.ms.p99).padStart(8),
        String(s.ms.max).padStart(8),
      ].join(' ');
    }),
    `export ready (a file to download): med ${scenarios.export.readyMs.med} ms, p95 ${scenarios.export.readyMs.p95} ms, max ${scenarios.export.readyMs.max} ms`,
  ];
  return {
    stdout: `\n${lines.join('\n')}\n\n`,
    [BASELINE_FILE]: `${JSON.stringify(baseline, null, 2)}\n`,
  };
}
