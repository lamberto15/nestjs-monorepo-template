// node --test loadtest/run.test.mjs
// run.sh's guards: the project names it accepts (`down` removes volumes),
// and the overlay it always applies, whatever COMPOSE_FILE says.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./run.sh', import.meta.url));
const run = (command, env) =>
  spawnSync('bash', [script, command], { encoding: 'utf8', env: { ...process.env, ...env } });
const docker = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' }).status === 0;

test('refuses any project not named loadtest-<name>, before touching anything', () => {
  for (const project of ['acme-api', 'nestjs-template', 'nestjs-monorepo-template', 'loadtest-', 'LOADTEST-x', 'loadtest', 'x-loadtest-1', 'loadtest-a b']) {
    const out = mkdtempSync(join(tmpdir(), 'loadtest-run-'));
    const result = run('down', { LOADTEST_PROJECT: project, LOADTEST_OUT: join(out, 'results') });
    assert.equal(result.status, 2, project);
    assert.match(result.stderr, /loadtest-<name>/);
    assert.equal(existsSync(join(out, 'results')), false, `${project}: nothing written`);
  }
});

test('applies the overlay even with COMPOSE_FILE exported', { skip: !docker && 'no docker compose' }, () => {
  const out = mkdtempSync(join(tmpdir(), 'loadtest-run-'));
  const result = run('config', {
    LOADTEST_PROJECT: 'loadtest-test',
    LOADTEST_OUT: out,
    COMPOSE_FILE: 'compose.yaml',
    COMPOSE_PROJECT_NAME: 'nestjs-monorepo-template',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^name: loadtest-test$/m);
  assert.match(result.stdout, /RATE_LIMIT_MULTIPLIER: "1000"/);
  assert.match(result.stdout, /APP_ENV: loadtest/);
  assert.doesNotMatch(result.stdout, /published:/);
  // Generated, never a default the scenarios know.
  assert.match(readFileSync(join(out, 'stack.env'), 'utf8'), /^ADMIN_PASSWORD=[0-9a-f]{48}$/m);
});

test('refuses a replica count or a bot check mode it does not know, before touching anything', () => {
  for (const env of [
    { LOADTEST_REPLICAS: '0' },
    { LOADTEST_REPLICAS: '7' },
    { LOADTEST_REPLICAS: 'two' },
    { LOADTEST_CAPTCHA: 'after-failures' },
  ]) {
    const out = mkdtempSync(join(tmpdir(), 'loadtest-run-'));
    const result = run('down', { LOADTEST_PROJECT: 'loadtest-test', LOADTEST_OUT: join(out, 'results'), ...env });
    assert.equal(result.status, 2, JSON.stringify(env));
    assert.match(result.stderr, /LOADTEST_(REPLICAS|CAPTCHA)=/);
    assert.equal(existsSync(join(out, 'results')), false, 'nothing written');
  }
});

test('sets the replicas, and the stub bot check only when asked', { skip: !docker && 'no docker compose' }, () => {
  const configOf = (env) => {
    const out = mkdtempSync(join(tmpdir(), 'loadtest-run-'));
    const result = run('config', { LOADTEST_PROJECT: 'loadtest-test', LOADTEST_OUT: out, ...env });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  const plain = configOf({});
  assert.match(plain, /replicas: 2/);
  assert.match(plain, /CAPTCHA_MODE: ['"]?off['"]?/);
  assert.match(plain, /CAPTCHA_PROVIDER: stub/);
  const full = configOf({ LOADTEST_REPLICAS: '4', LOADTEST_CAPTCHA: 'always' });
  assert.match(full, /replicas: 4/);
  assert.match(full, /CAPTCHA_MODE: always/);
  assert.doesNotMatch(full, /TURNSTILE_SECRET_KEY: "?[^"\s]/);
});
