import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  classify,
  comparisonFiles,
  expectedJobs,
  gitFiles,
  keys,
} from './changes.mjs';
import { gate } from './gate.mjs';
import { publicationGate } from './publication-gate.mjs';

const route = (...files) => classify({ files });
const selected = (flags) => keys.filter((k) => flags[k]);

test('API and web changes route independently on PRs and main', () => {
  const api = route('apps/api/src/features/notes/notes.service.ts');
  assert.deepEqual(selected(api), ['code', 'app', 'api', 'image', 'api_image']);
  const web = route('apps/web/src/routes/index.tsx');
  assert.deepEqual(selected(web), ['code', 'app', 'web', 'caddy']);
  for (const event of ['push', 'pull_request']) {
    assert.ok(expectedJobs(api, event).includes('e2e'));
    assert.ok(!expectedJobs(web, event).includes('e2e'));
    assert.ok(expectedJobs(web, event).includes('e2e-web'));
    assert.ok(!expectedJobs(api, event).includes('unit-web'));
  }
});

test('shared, migrations, infrastructure, tooling, CI and unknown paths', () => {
  for (const path of ['new-root-file', 'packages/new-shared/src/index.ts'])
    assert.ok(route(path).full, path);
  for (const path of [
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'turbo.json',
  ]) {
    assert.ok(route(path).api && route(path).web);
    assert.equal(route(path).full, false);
  }
  assert.ok(route('packages/api-client/src/client.ts').web);
  assert.ok(route('packages/api-client/src/client.ts').api);
  assert.ok(route('apps/api/drizzle/0001.sql').api);
  assert.ok(route('apps/api/src/platform/records/record.ts').generator);
  const infra = route('compose.yaml');
  assert.ok(infra.stack && infra.services && infra.image);
  assert.ok(!infra.api && !infra.web);
  assert.ok(route('backup/Dockerfile').backup);
  assert.ok(route('gotenberg/Dockerfile').gotenberg);
  assert.ok(route('caddy/Dockerfile').caddy);
  assert.ok(route('tools/feature/add.mjs').generator);
  assert.ok(route('tools/deploy/rolling.mjs').stack);
  for (const file of ['.github/workflows/ci.yml', 'tools/ci/changes.mjs'])
    assert.deepEqual(selected(route(file)), ['ci']);
  for (const file of [
    'README.md',
    'docs/deployment.md',
    'deploy/helm/app/values.yaml',
    'deploy/k3s/data.yaml',
  ])
    assert.deepEqual(selected(route(file)), []);
});

test('ambiguous comparisons and comprehensive triggers never skip checks', () => {
  for (const input of [
    { files: [] },
    { files: null },
    { files: ['apps/web/a'], complete: false },
    { files: ['docs/a'], full: true },
  ])
    assert.ok(keys.every((k) => classify(input)[k]));
  const full = classify({ full: true });
  for (const event of ['schedule', 'workflow_dispatch', 'push']) {
    const jobs = expectedJobs(full, event);
    assert.ok(jobs.includes('template-without-notes'));
    assert.ok(jobs.includes('e2e-web'));
    assert.ok(jobs.includes('feature-smoke'));
  }
});

test('compare parsing includes deleted and both renamed paths and rejects caps', () => {
  const files = [
    {
      filename: 'apps/web/new.ts',
      previous_filename: 'apps/api/old.ts',
      status: 'renamed',
    },
    { filename: 'tools/gone.mjs', status: 'removed' },
  ];
  assert.deepEqual(comparisonFiles({ status: 'ahead', files }), [
    'apps/web/new.ts',
    'apps/api/old.ts',
    'tools/gone.mjs',
  ]);
  assert.deepEqual(
    comparisonFiles([[files[0]], [files[1]]], { pr: true, expected: 2 }),
    ['apps/web/new.ts', 'apps/api/old.ts', 'tools/gone.mjs'],
  );
  for (const data of [
    { status: 'ahead', files: [] },
    { status: 'diverged', files },
    { status: 'ahead', files: Array(300).fill(files[0]) },
    { status: 'ahead', files: [{ filename: 'new', status: 'renamed' }] },
  ])
    assert.equal(comparisonFiles(data), null);
  assert.equal(comparisonFiles([files], { pr: true, expected: 3 }), null);
  assert.equal(
    comparisonFiles([Array(3000).fill(files[0])], { pr: true, expected: 3000 }),
    null,
  );
});

test('local Git comparisons are NUL delimited, include deletes and fail closed', () => {
  const calls = [];
  const run = (...args) => {
    calls.push(args);
    return 'apps/api/deleted.ts\0apps/web/new name.ts\0';
  };
  assert.deepEqual(gitFiles('a'.repeat(40), 'b'.repeat(40), run), [
    'apps/api/deleted.ts',
    'apps/web/new name.ts',
  ]);
  assert.ok(calls[1][1].includes('--no-renames'));
  assert.equal(
    gitFiles('a'.repeat(40), 'b'.repeat(40), () => {
      throw Error('missing history');
    }),
    null,
  );
  assert.equal(gitFiles('unknown', 'HEAD', run), null);
});

test('gate rejects missing results, failures, cancellations and unexpected skips', () => {
  const expected = ['changes', 'e2e'];
  const needs = {
    changes: { result: 'success' },
    e2e: { result: 'success' },
    'unit-web': { result: 'skipped' },
  };
  gate(expected, needs);
  for (const result of ['skipped', 'failure', 'cancelled', ''])
    assert.throws(() => gate(expected, { ...needs, e2e: { result } }));
  assert.throws(() => gate(expected, { changes: { result: 'success' } }));
  assert.throws(() =>
    gate(expected, { ...needs, 'unit-web': { result: 'failure' } }),
  );
  assert.throws(() => gate([], needs));
});

test('publication gate rejects a failed or skipped required image', () => {
  const flags = { api_image: 'true', caddy: 'false', gotenberg: 'false' };
  const needs = {
    publish: { result: 'success' },
    'publish-caddy': { result: 'skipped' },
    'publish-gotenberg': { result: 'skipped' },
  };
  publicationGate(flags, needs);
  assert.throws(
    () =>
      publicationGate(flags, needs, {
        error: 'Trusted manifest missing; bootstrap required',
      }),
    /bootstrap/,
  );
  for (const result of ['failure', 'cancelled', 'skipped'])
    assert.throws(() =>
      publicationGate(flags, { ...needs, publish: { result } }),
    );
});

test('benchmark routing preserves coverage merging only for sharded runs', () => {
  assert.deepEqual(expectedJobs({}, 'workflow_dispatch', 'e2e'), [
    'changes',
    'compose-images',
    'e2e',
  ]);
  assert.deepEqual(expectedJobs({}, 'workflow_dispatch', 'unit', true), [
    'changes',
    'unit-api',
    'unit-web',
  ]);
  assert.ok(expectedJobs({}, 'workflow_dispatch', 'unit').includes('coverage'));
});
