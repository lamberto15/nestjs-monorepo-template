// The drain check's tests (node --test tools/deploy/drain-check.test.mjs): a
// fake `docker` first on PATH answers as a draining container would and logs
// its arguments, so no daemon is needed.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./drain-check.mjs', import.meta.url));

describe('drain-check', () => {
  let dir;
  let log;
  const check = (...args) =>
    spawnSync(process.execPath, [script, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${dir}${path.delimiter}${process.env.PATH}`,
        DOCKER_LOG: log,
      },
    });
  const calls = () =>
    existsSync(log)
      ? readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse)
      : [];

  before(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'drain-check-'));
    log = path.join(dir, 'calls.jsonl');
    // The container drained as it should: 503, then refused, the request in
    // flight answered (401: wrong password), and a clean exit.
    writeFileSync(
      path.join(dir, 'docker.cjs'),
      `const args = process.argv.slice(2);
require('node:fs').appendFileSync(process.env.DOCKER_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'exec') {
  console.log('READY');
  console.log(JSON.stringify({ health: [200, 503, 'ECONNREFUSED'], slow: { status: 401 } }));
}
if (args[0] === 'inspect') console.log('exited 0');
`,
    );
    writeFileSync(
      path.join(dir, 'docker'),
      `#!/bin/sh\nexec "${process.execPath}" "${path.join(dir, 'docker.cjs')}" "$@"\n`,
    );
    chmodSync(path.join(dir, 'docker'), 0o755);
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  // Claude runs it: the container is a name or an ID, never an option (#471).
  it('refuses a container that is not a name or an ID, before docker runs', () => {
    for (const args of [[], ['-v'], ['--help'], ['a;b'], ['../x'], ['a b']]) {
      const run = check(...args);
      assert.equal(run.status, 2, args.join(' '));
      assert.match(run.stderr, /usage: drain-check\.mjs/);
    }
    assert.deepEqual(calls(), []);
  });

  it('checks a container by name: -- before it, the probe as node -e, no file', () => {
    const name = 'nestjs-monorepo-template-api-3';
    const run = check(name);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /^OK: /m);
    const seen = calls();
    assert.deepEqual(seen[0].slice(0, 5), ['exec', '--', name, 'node', '-e']);
    assert.match(seen[0][5], /READY/);
    assert.deepEqual(
      seen.find((c) => c[0] === 'inspect'),
      [
        'inspect',
        '--format',
        '{{.State.Status}} {{.State.ExitCode}}',
        '--',
        name,
      ],
    );
    assert.deepEqual(
      seen.find((c) => c[0] === 'kill'),
      ['kill', '--signal', 'TERM', '--', name],
    );
    assert.equal(
      seen.some((c) => c[0] === 'cp'),
      false,
    );
  });
});
