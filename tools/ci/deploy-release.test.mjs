import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createManifest } from './release-manifest.mjs';
import {
  deploymentManifest,
  deploymentRun,
  releaseRunId,
  requireStagingDeploy,
} from './deploy-release.mjs';
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
    backup: 'sha256:' + '4'.repeat(64),
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
// A fake gh for deploymentRun: releases by tag, run artifacts, CI runs.
function github({ releases = {}, artifacts = {}, runs = [] } = {}) {
  const calls = [];
  const run = (command, args) => {
    calls.push([command, ...args].join(' '));
    const [verb, path] = args;
    if (verb === 'api' && path.includes('/releases/tags/')) {
      const tag = path.split('/').at(-1);
      if (!releases[tag]) throw new Error('HTTP 404');
      return JSON.stringify({ tag_name: tag, ...releases[tag] });
    }
    if (verb === 'api' && path.includes('/artifacts')) {
      const runId = path.split('/runs/')[1].split('/')[0];
      return JSON.stringify({ artifacts: artifacts[runId] ?? [] });
    }
    if (verb === 'api' && path.includes('/workflows/ci.yml/runs'))
      return JSON.stringify({ workflow_runs: runs });
    if (verb === 'release' && path === 'download') {
      writeFileSync(
        join(args.at(-1), 'release-manifest.json'),
        JSON.stringify({ runId: releases[args[2]].runId }),
      );
      return '';
    }
    throw new Error(`unexpected ${command} ${args.join(' ')}`);
  };
  return { run, calls };
}
const kept = [{ name: 'release-manifest-v1', expired: false }];
const asset = [{ name: 'release-manifest.json' }];
const published = { draft: false, prerelease: false, assets: asset, runId: 77 };

test('production deploys only a published, non-pre-release tag, and only by hand', () => {
  const base = { repository, environment: 'production' };
  const { run } = github({
    releases: {
      'v1.2.0': published,
      'v1.3.0-rc.1': { ...published, prerelease: true },
      'v1.3.0': { ...published, draft: true },
      'v1.4.0': { ...published, assets: [] },
    },
  });
  assert.equal(
    deploymentRun({ ...base, event: 'workflow_dispatch', tag: 'v1.2.0' }, run),
    '77',
  );
  for (const [input, message] of [
    [{ event: 'workflow_run', workflowRunId: '5' }, /only by a manual/],
    [{ event: 'workflow_dispatch' }, /needs a release tag/],
    [{ event: 'workflow_dispatch', tag: 'v1.3.0-rc.1' }, /pre-release/],
    [{ event: 'workflow_dispatch', tag: 'v1.3.0' }, /draft/],
    [{ event: 'workflow_dispatch', tag: 'v1.4.0' }, /no release-manifest/],
    [{ event: 'workflow_dispatch', tag: 'v9.9.9' }, /404/],
    [{ event: 'workflow_dispatch', tag: 'main' }, /Not a release tag/],
    [
      { event: 'workflow_dispatch', tag: 'v1.2.0 --repo x/y' },
      /Not a release tag/,
    ],
  ])
    assert.throws(() => deploymentRun({ ...base, ...input }, run), message);
  assert.throws(
    () =>
      deploymentRun(
        { repository, environment: 'qa', event: 'workflow_dispatch' },
        run,
      ),
    /Unknown environment/,
  );
});

test('staging takes the CI run that published, a pre-release tag, or the newest main build', () => {
  const base = { repository, environment: 'staging' };
  const { run } = github({
    releases: { 'v1.3.0-rc.1': { ...published, prerelease: true, runId: 88 } },
    artifacts: { 41: kept, 40: [{ ...kept[0], expired: true }], 39: kept },
    runs: [
      { id: 42, event: 'schedule' },
      { id: 41, event: 'push' },
      { id: 39, event: 'push' },
    ],
  });
  assert.equal(
    deploymentRun({ ...base, event: 'workflow_run', workflowRunId: '41' }, run),
    '41',
  );
  // A main run that published nothing (no manifest): nothing to deploy.
  assert.equal(
    deploymentRun({ ...base, event: 'workflow_run', workflowRunId: '40' }, run),
    null,
  );
  assert.equal(
    deploymentRun(
      { ...base, event: 'workflow_dispatch', tag: 'v1.3.0-rc.1' },
      run,
    ),
    '88',
  );
  // Empty tag: the newest successful main push or dispatch with a manifest.
  assert.equal(
    deploymentRun({ ...base, event: 'workflow_dispatch' }, run),
    '41',
  );
  assert.throws(() =>
    deploymentRun(
      { ...base, event: 'workflow_run', workflowRunId: '--repo=x/y' },
      run,
    ),
  );
});

test('Deploy verifies before any secret, targets Swarm by digest and never builds', () => {
  const text = readFileSync(
    new URL('../../.github/workflows/deploy.yml', import.meta.url),
    'utf8',
  );
  assert.match(text, /workflow_run:\n    workflows: \['CI \/ CD'\]/);
  assert.match(text, /branches: \[main\]/);
  assert.match(text, /options: \[staging, production\]/);
  // Automatic deploys need AUTO_DEPLOY and always go to staging.
  assert.match(text, /vars.AUTO_DEPLOY == 'true'/);
  assert.match(
    text,
    /github.event_name == 'workflow_run' && 'staging' \|\| inputs.environment/,
  );
  // The verify job holds no environment and no secret but the token.
  const verify = text.slice(
    text.indexOf('  verify:'),
    text.indexOf('  deploy:'),
  );
  assert.ok(!verify.includes('environment:\n'));
  assert.ok(!/secrets\.(?!GITHUB_TOKEN)/.test(verify));
  assert.match(verify, /node tools\/ci\/deploy-release.mjs/);
  const deploy = text.slice(text.indexOf('  deploy:'));
  assert.match(deploy, /needs: verify/);
  assert.match(deploy, /name: \$\{\{ needs.verify.outputs.environment \}\}/);
  assert.match(
    deploy,
    /group: deploy-\$\{\{ needs.verify.outputs.environment \}\}\n      cancel-in-progress: false/,
  );
  assert.match(deploy, /ref: \$\{\{ needs.verify.outputs.source_sha \}\}/);
  assert.match(
    deploy,
    /SWARM_OVERLAYS: \$\{\{ vars.SWARM_OVERLAYS \|\| 'compose.small.yaml' \}\}/,
  );
  // The tailnet tag is the environment's, never one shared by both.
  assert.match(deploy, /tags: \$\{\{ env.TS_TAG \}\}/);
  assert.match(deploy, /TS_TAG: \$\{\{ vars.TS_TAG \}\}/);
  assert.match(deploy, /node tools\/deploy\/swarm.mjs deploy --env-file/);
  assert.ok(
    deploy.indexOf('Join the deployment tailnet') <
      deploy.indexOf('Deploy the stack'),
  );
  assert.ok(!text.includes('docker/build-push-action'));
  assert.ok(!/helm|kubectl/i.test(text));
});

test('production needs a green staging deploy of its source or a newer commit', () => {
  const deploys = (runs, jobs) => (command, args) => {
    const path = args[1];
    if (path.includes('/workflows/deploy.yml/runs'))
      return JSON.stringify({ workflow_runs: runs });
    const runId = path.split('/runs/')[1].split('/')[0];
    return JSON.stringify({ jobs: jobs[runId] ?? [] });
  };
  // 'old' is before the source; 'new' contains it.
  const isAncestor = (commit, descendant) =>
    commit === source && descendant !== 'old';
  const staging = (id, sha) => ({
    id,
    head_sha: sha,
    display_title: 'Deploy staging ',
  });
  const passed = [
    { name: 'verify', conclusion: 'success' },
    { name: 'deploy', conclusion: 'success' },
  ];
  const skipped = [
    { name: 'verify', conclusion: 'success' },
    { name: 'deploy', conclusion: 'skipped' },
  ];
  assert.doesNotThrow(() =>
    requireStagingDeploy(
      repository,
      source,
      isAncestor,
      deploys([staging(3, 'new'), staging(2, source)], {
        3: skipped,
        2: passed,
      }),
    ),
  );
  for (const [runs, jobs] of [
    [[], {}],
    [[staging(1, 'old')], { 1: passed }],
    [[staging(2, source)], { 2: skipped }],
    [
      [{ ...staging(2, source), display_title: 'Deploy production v1.2.0' }],
      { 2: passed },
    ],
  ])
    assert.throws(
      () =>
        requireStagingDeploy(
          repository,
          source,
          isAncestor,
          deploys(runs, jobs),
        ),
      /Staging has not deployed/,
    );
});
