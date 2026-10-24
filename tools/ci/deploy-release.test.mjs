import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createManifest } from './release-manifest.mjs';
import { deploymentManifest, releaseRunId } from './deploy-release.mjs';
const repository = 'owner/repo',
  source = 'a'.repeat(40),
  head = 'b'.repeat(40),
  id = '123';
const record = {
  id: 123,
  conclusion: 'success',
  head_branch: 'main',
  head_sha: source,
  event: 'workflow_dispatch',
  path: '.github/workflows/ci.yml',
  repository: { full_name: repository },
};
const manifest = createManifest({
  repository,
  sourceSha: source,
  runId: 123,
  published: {
    api: 'sha256:' + '1'.repeat(64),
    caddy: 'sha256:' + '2'.repeat(64),
    gotenberg: 'sha256:' + '3'.repeat(64),
  },
});
function fixture({ metadata = record, document = manifest, fail } = {}) {
  const calls = [];
  return {
    calls,
    run: (command, args) => {
      calls.push([command, args]);
      if (fail?.(command, args)) throw new Error('verification rejected');
      if (command === 'gh' && args[0] === 'api')
        return JSON.stringify(metadata);
      if (command === 'gh' && args[0] === 'run')
        writeFileSync(
          join(args.at(-1), 'release-manifest.json'),
          JSON.stringify(document),
        );
      return '';
    },
  };
}
test('release IDs are data, never command flags or mutable refs', () => {
  assert.equal(releaseRunId('123'), '123');
  for (const value of [
    '0',
    '-1',
    'main',
    '--repo=attacker/repo',
    '1\n2',
    '9007199254740992',
    ' 123',
  ])
    assert.throws(() => releaseRunId(value));
});
test('deploy resolves the exact successful run and verifies every immutable image', () => {
  const { run, calls } = fixture();
  assert.deepEqual(deploymentManifest(repository, id, head, run), manifest);
  assert.ok(
    calls.find(
      ([command, args]) =>
        command === 'gh' &&
        args.includes('123') &&
        args.includes('release-manifest-v1'),
    ),
  );
  assert.equal(calls.filter(([command]) => command === 'docker').length, 3);
  assert.equal(
    calls.filter(
      ([command, args]) => command === 'cosign' && args[0] === 'verify',
    ).length,
    3,
  );
  assert.equal(
    calls.filter(
      ([command, args]) => command === 'gh' && args.includes('--source-digest'),
    ).length,
    3,
  );
});
test('untrusted source runs are rejected before downloading an artifact', () => {
  for (const patch of [
    { id: 456 },
    { conclusion: 'failure' },
    { head_branch: 'feature' },
    { event: 'pull_request' },
    { path: '.github/workflows/deploy.yml' },
    { repository: { full_name: 'attacker/repo' } },
  ]) {
    const { run, calls } = fixture({ metadata: { ...record, ...patch } });
    assert.throws(() => deploymentManifest(repository, id, head, run));
    assert.equal(calls.length, 1);
  }
});
test('missing artifacts, mismatched source, ancestry and signature failures block deployment', () => {
  const cases = [
    fixture({ document: { ...manifest, sourceSha: head } }),
    fixture({ fail: (cmd, args) => cmd === 'gh' && args[0] === 'run' }),
    fixture({ fail: (cmd) => cmd === 'git' }),
    fixture({ fail: (cmd) => cmd === 'docker' }),
    fixture({ fail: (cmd) => cmd === 'cosign' }),
    fixture({ fail: (cmd, args) => cmd === 'gh' && args[0] === 'attestation' }),
  ];
  for (const { run } of cases)
    assert.throws(() => deploymentManifest(repository, id, head, run));
});
test('Deploy is manual, protected, serialized and uses release chart code without rebuilding', () => {
  const text = readFileSync(
    new URL('../../.github/workflows/deploy.yml', import.meta.url),
    'utf8',
  );
  assert.match(text, /on:\n  workflow_dispatch:/);
  assert.match(text, /github.ref == 'refs\/heads\/main'/);
  assert.match(text, /environment:\n      name: production/);
  assert.ok(
    text.indexOf('Require production deployment to be enabled') <
      text.indexOf('actions/checkout@'),
  );
  assert.match(text, /DEPLOY_ENABLED: \$\{\{ vars.K3S_DEPLOY_ENABLED \}\}/);
  assert.match(text, /group: production-k3s\n      cancel-in-progress: false/);
  assert.match(text, /ref: \$\{\{ steps.release.outputs.source_sha \}\}/);
  assert.ok(
    text.indexOf('node tools/ci/deploy-release.mjs') <
      text.indexOf('Join the deployment tailnet'),
  );
  assert.ok(!text.includes('docker/build-push-action'));
  assert.match(
    text,
    /--rollback-on-failure --wait=legacy --wait-for-jobs --timeout 12m/,
  );
  for (const component of ['api', 'worker', 'web', 'gotenberg'])
    assert.ok(text.includes(`rollout status deployment/app-${component}`));
});
