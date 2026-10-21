// Proves the graceful shutdown on a running container (docs/deploy-rolling.md):
//
//   node tools/deploy/drain-check.mjs <api container name or id>
//   node --test tools/deploy/drain-check.test.mjs   # its tests (a fake docker)
//
// Inside the container a request is left in flight (its body trickles in),
// SIGTERM is sent to the container, and the check asserts that:
//   1. /health turns 503 (readiness) while the process drains,
//   2. then new connections are refused,
//   3. the request in flight still completes with a response,
//   4. the container exits 0 right after, with its keep-alive connection closed.
// It KILLS the container's main process: run it on a throwaway replica
// (`docker compose up -d --scale api=3`, then pass the third), never alone.
import { execFileSync, spawn } from 'node:child_process';

/**
 * A container's name or ID, as Docker allows them (names: [a-zA-Z0-9]
 * then [a-zA-Z0-9_.-]; IDs are hex). It starts with a letter or a digit, so
 * it never reads as an option; `--` before it in every docker call says so
 * to docker too (#471).
 */
const CONTAINER = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

// Runs inside the container (its Node, no dependency).
const probe = `
const http = require('node:http');
const t0 = Date.now();
const out = { health: [], slow: null };
const body = JSON.stringify({ email: 'a@example.com', ['pass' + 'word']: 'nope-nope-nope' });
const agent = new http.Agent({ keepAlive: true });
const slow = http.request({ host: '127.0.0.1', port: 3000, method: 'POST', path: '/v1/auth/token', agent,
  headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => {
  res.resume();
  res.on('end', () => { out.slow = { status: res.statusCode, at: Date.now() - t0 };
    // The container may exit right after this: report now.
    console.log(JSON.stringify(out)); });
});
slow.on('error', (e) => { out.slow = { error: e.message, at: Date.now() - t0 }; });
slow.write(body.slice(0, 5));
console.log('READY');
const timer = setInterval(() => {
  const r = http.get({ host: '127.0.0.1', port: 3000, path: '/health', agent: false }, (res) => {
    res.resume(); out.health.push(res.statusCode);
  });
  r.on('error', (e) => out.health.push(e.code));
}, 500);
setTimeout(() => slow.end(body.slice(5)), 9000);
setTimeout(() => { clearInterval(timer); console.log(JSON.stringify(out)); process.exit(0); }, 12000);
`;

/** The check, on a container already known to be a name or an ID. */
async function drain(container) {
  // The probe is node's -e argument: no file to write, here or in the
  // container's shared /tmp.
  const child = spawn('docker', ['exec', '--', container, 'node', '-e', probe]);
  let stdout = '';
  child.stdout.on('data', (d) => {
    stdout += d;
    if (stdout.includes('READY') && !child.killed && !globalThis.sent) {
      globalThis.sent = true;
      setTimeout(
        () =>
          execFileSync('docker', ['kill', '--signal', 'TERM', '--', container]),
        1500,
      );
    }
  });
  await new Promise((resolve) => child.on('close', resolve));
  const result = JSON.parse(
    stdout
      .trim()
      .split('\n')
      .filter((l) => l.startsWith('{'))
      .at(-1),
  );
  let exit = '';
  for (let i = 0; i < 20; i++) {
    exit = execFileSync('docker', [
      'inspect',
      '--format',
      '{{.State.Status}} {{.State.ExitCode}}',
      '--',
      container,
    ])
      .toString()
      .trim();
    if (exit.startsWith('exited')) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  console.log(JSON.stringify({ ...result, container: exit }));

  const failures = [];
  if (!result.health.includes(503))
    failures.push('/health never answered 503 while draining');
  if (!result.health.includes('ECONNREFUSED'))
    failures.push('new connections were never refused');
  if (result.slow?.status !== 401)
    failures.push(
      `the request in flight did not complete: ${JSON.stringify(result.slow)}`,
    );
  if (exit !== 'exited 0')
    failures.push(`the container ended as "${exit}", not "exited 0"`);
  if (failures.length > 0) {
    console.error('FAILED:\n- ' + failures.join('\n- '));
    process.exit(1);
  }
  console.log(
    'OK: 503 on /health, new connections refused, the request in flight completed, clean exit.',
  );
}

const container = process.argv[2] ?? '';
if (CONTAINER.test(container)) {
  await drain(container);
} else {
  console.error('usage: drain-check.mjs <container name or id>');
  process.exitCode = 2;
}
