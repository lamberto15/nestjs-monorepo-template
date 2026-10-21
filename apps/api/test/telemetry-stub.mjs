// A stand-in collector for CI (the "e2e with telemetry on" job): accepts what
// the app exports and counts it, so the run proves the instrumentation was
// active and that the app and the tests work with it.
//
//   node test/telemetry-stub.mjs serve [port]   serve (OTLP/HTTP and Sentry) until stopped
//   node test/telemetry-stub.mjs check [port]   exit 1 unless traces arrived
//
// OTLP/HTTP: POST /v1/traces, /v1/metrics. Sentry: POST /api/<id>/envelope/.
// Anything else: 404. GET /stats: the counts as JSON.
import { createServer } from 'node:http';

const [mode = 'serve', portArg = '4318'] = process.argv.slice(2);
const port = Number(portArg);

if (mode === 'check') {
  const stats = await fetch(`http://127.0.0.1:${port}/stats`).then((r) =>
    r.json(),
  );
  console.log(`Collector received: ${JSON.stringify(stats)}`);
  if (!stats.traces) {
    console.error(
      'No trace reached the collector: the instrumentation did not run.',
    );
    process.exit(1);
  }
  process.exit(0);
}

const stats = { traces: 0, metrics: 0, sentryEnvelopes: 0, other: 0 };
createServer((request, response) => {
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
  request.resume();
  request.on('end', () => {
    if (path === '/v1/traces') stats.traces += 1;
    else if (path === '/v1/metrics') stats.metrics += 1;
    else stats.sentryEnvelopes += 1;
    response.setHeader('Content-Type', 'application/json');
    response.end('{}');
  });
}).listen(port, '127.0.0.1', () =>
  console.log(`Stub collector on 127.0.0.1:${port}`),
);
