// A stand-in collector for CI (the "e2e with telemetry on" job): accepts what
// the app exports and counts it, so the run proves the instrumentation was
// active and that the app and the tests work with it.
//
//   node test/telemetry-stub.mjs serve [port]   serve (OTLP/HTTP and Sentry) until stopped
//   node test/telemetry-stub.mjs check [port]   exit 1 unless a request served was traced
//   node test/telemetry-stub.mjs boot           start the built app (node dist/main) against a collector of its own; exit 1 unless it was traced
//
// OTLP/HTTP: POST /v1/traces, /v1/metrics. Sentry: POST /api/<id>/envelope/.
// Anything else: 404. GET /stats: the counts as JSON.
//
// `boot` is the test of the start-up order: the e2e suite starts the SDKs
// itself, before it loads the app (test/setup-env.ts), which is the working
// order. Only the real entry point shows whether `main.ts` does the same: the
// spans of a request served by `node dist/main` must be there, and the secrets
// in its query string must not be (build the API first; the database and Redis
// come from DATABASE_URL, DATABASE_OWNER_URL, DATABASE_MAINTENANCE_URL and
// REDIS_URL).
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = 2; // SpanKind.SERVER in OTLP/JSON

/** A collector on `port` (0: any free one): the counts, and what it was sent. */
function startCollector(port) {
  const stats = {
    traces: 0,
    metrics: 0,
    sentryEnvelopes: 0,
    other: 0,
    spans: 0,
    serverSpans: 0,
    scopes: {},
  };
  const seen = { headers: new Set(), traces: '' };
  const server = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/stats') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(stats));
      return;
    }
    const path = request.url?.split('?')[0] ?? '';
    const known =
      request.method === 'POST' &&
      (path === '/v1/traces' ||
        path === '/v1/metrics' ||
        /^\/api\/\d+\/envelope\/?$/.test(path));
    if (!known) {
      stats.other += 1;
      response.statusCode = 404;
      response.end();
      return;
    }
    const body = [];
    request.on('data', (chunk) => body.push(chunk));
    request.on('end', () => {
      if (path === '/v1/traces') {
        stats.traces += 1;
        for (const value of Object.values(request.headers)) {
          seen.headers.add(String(value));
        }
        const text = Buffer.concat(body).toString();
        seen.traces += text;
        countSpans(stats, text);
      } else if (path === '/v1/metrics') {
        stats.metrics += 1;
      } else {
        stats.sentryEnvelopes += 1;
      }
      response.setHeader('Content-Type', 'application/json');
      response.end('{}');
    });
  });
  return new Promise((resolve) =>
    server.listen(port, '127.0.0.1', () => resolve({ server, stats, seen })),
  );
}

/** The spans of an OTLP/JSON export, by instrumentation scope. */
function countSpans(stats, text) {
  try {
    for (const resource of JSON.parse(text).resourceSpans ?? []) {
      for (const scope of resource.scopeSpans ?? []) {
        for (const span of scope.spans ?? []) {
          stats.spans += 1;
          if (span.kind === SERVER) stats.serverSpans += 1;
          const name = String(scope.scope?.name);
          stats.scopes[name] = (stats.scopes[name] ?? 0) + 1;
        }
      }
    }
  } catch {
    // Not JSON (a protobuf exporter): the posts are still counted.
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(condition, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await condition()) return true;
    await sleep(250);
  }
  return false;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/**
 * Starts `node dist/main`, as the production image does, with OpenTelemetry
 * and Sentry configured through `_FILE` secrets, sends it a request with
 * secrets in the query string, and checks what the collector got.
 */
async function boot() {
  const api = fileURLToPath(new URL('..', import.meta.url));
  const problems = [];
  if (!existsSync(join(api, 'dist/main.js'))) {
    problems.push(
      'dist/main.js is missing: build the API first (pnpm --filter @nestjs-monorepo-template/api build)',
    );
  }
  for (const name of [
    'DATABASE_URL',
    'DATABASE_OWNER_URL',
    'DATABASE_MAINTENANCE_URL',
    'REDIS_URL',
  ]) {
    if (!process.env[name]) problems.push(`${name} is not set`);
  }
  if (problems.length > 0) {
    console.error(problems.join('\n'));
    return 2;
  }

  const { server, stats, seen } = await startCollector(0);
  const collector = `http://127.0.0.1:${server.address().port}`;
  const directory = mkdtempSync(join(tmpdir(), 'telemetry-boot-'));
  const headersFile = join(directory, 'otlp-headers');
  writeFileSync(headersFile, 'x-boot-check=read-from-a-file\n');
  const dsnFile = join(directory, 'sentry-dsn');
  writeFileSync(dsnFile, `http://public@${collector.slice(7)}/1\n`);
  const port = await freePort();
  const appUrl = `http://127.0.0.1:${port}`;

  const env = {
    NODE_ENV: 'development',
    MIGRATE_ON_START: 'on',
    APP_URL: appUrl,
    WEB_URL: appUrl,
    MAIL_TRANSPORT: 'log',
    STORAGE_DRIVER: 'memory',
    PASSWORD_BREACH_CHECK: 'off',
    DATA_ENCRYPTION_KEYS: randomBytes(32).toString('base64'),
    BLIND_INDEX_KEYS: randomBytes(32).toString('base64'),
    REDIS_PREFIX: `boot-${randomBytes(4).toString('hex')}`,
    ...process.env,
    PORT: String(port),
    // The credentials as secrets in files (docs/configuration.md): the SDKs
    // start before the environment is validated, so they read them themselves.
    OTEL_EXPORTER_OTLP_ENDPOINT: collector,
    OTEL_EXPORTER_OTLP_HEADERS_FILE: headersFile,
    SENTRY_DSN_FILE: dsnFile,
    OTEL_BSP_SCHEDULE_DELAY: '500',
  };
  delete env.OTEL_EXPORTER_OTLP_HEADERS;
  delete env.SENTRY_DSN;

  const app = spawn(process.execPath, ['dist/main.js'], {
    cwd: api,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  app.stdout.on('data', (chunk) => (output += chunk));
  app.stderr.on('data', (chunk) => (output += chunk));
  let exited = false;
  app.once('exit', () => (exited = true));

  const failures = [];
  try {
    const up = await until(async () => {
      if (exited) return true;
      return fetch(`${appUrl}/health/live`).then(
        (response) => response.ok,
        () => false,
      );
    }, 90_000);
    if (!up || exited) {
      failures.push('the app did not start');
    } else {
      // A route that is not there still makes a server span, with the query.
      await fetch(
        `${appUrl}/v1/telemetry-boot-check?code=BOOT-CODE-1234&state=BOOT-STATE-5678&page=2`,
      );
      await until(
        () =>
          stats.serverSpans > 0 &&
          stats.scopes['@opentelemetry/instrumentation-pg'] > 0,
        20_000,
      );
    }
  } finally {
    if (!exited) {
      app.kill('SIGTERM');
      if (!(await until(() => exited, 30_000))) app.kill('SIGKILL');
    }
  }

  const scopeNames = Object.keys(stats.scopes);
  const traced = (pattern) => scopeNames.some((name) => pattern.test(name));
  if (failures.length === 0) {
    if (stats.serverSpans === 0) {
      failures.push(
        'no span for the request the app served: the SDK started after http was loaded',
      );
    }
    if (!traced(/instrumentation-pg/)) {
      failures.push('no PostgreSQL span: pg was loaded before the SDK started');
    }
    if (!traced(/instrumentation-(express|router)/)) {
      failures.push(
        'no Express span: Express was loaded before the SDK started',
      );
    }
    if (!seen.headers.has('read-from-a-file')) {
      failures.push(
        "the collector did not get OTEL_EXPORTER_OTLP_HEADERS_FILE's header",
      );
    }
    if (!seen.traces.includes('page=2')) {
      failures.push("the request's query is not in its span");
    }
    for (const secret of ['BOOT-CODE-1234', 'BOOT-STATE-5678']) {
      if (seen.traces.includes(secret)) {
        failures.push(`a span carries the query's secret ${secret}`);
      }
    }
  }
  console.log(
    `Booted app: spans=${stats.spans} serverSpans=${stats.serverSpans} scopes=${scopeNames.join(', ')}`,
  );
  rmSync(directory, { recursive: true, force: true });
  server.close();
  if (failures.length > 0) {
    console.error(failures.join('\n'));
    console.error(
      `--- the app's output (last lines)\n${output.split('\n').slice(-40).join('\n')}`,
    );
    return 1;
  }
  return 0;
}

const [mode = 'serve', portArg = '4318'] = process.argv.slice(2);

if (mode === 'boot') {
  process.exit(await boot());
}

const port = Number(portArg);

if (mode === 'check') {
  const stats = await fetch(`http://127.0.0.1:${port}/stats`).then((r) =>
    r.json(),
  );
  // Only the counts, as numbers: nothing the response carries reaches the log.
  const count = (key) => Number(stats[key]) || 0;
  console.log(
    `Collector received: traces=${count('traces')} metrics=${count('metrics')} sentryEnvelopes=${count('sentryEnvelopes')} spans=${count('spans')} serverSpans=${count('serverSpans')} other=${count('other')}`,
  );
  // Posts alone prove little: an outgoing request is traced however late the
  // SDK started. A request the app *served* is traced only if it started first.
  if (count('serverSpans') === 0) {
    console.error(
      'No span for a request the app served reached the collector: the instrumentation did not run.',
    );
    process.exit(1);
  }
  process.exit(0);
}

await startCollector(port);
console.log(`Stub collector on 127.0.0.1:${port}`);
