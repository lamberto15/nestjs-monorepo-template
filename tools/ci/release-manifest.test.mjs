import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classify, gitFiles } from './changes.mjs';
import {
  components,
  createManifest,
  validateManifest,
  validateEvidence,
  verifyImages,
  trustedManifest,
} from './release-manifest.mjs';
const repository = 'owner/repo';
const oldSha = 'a'.repeat(40),
  newSha = 'b'.repeat(40);
const dig = (n) => 'sha256:' + String(n).repeat(64);
const previous = createManifest({
  repository,
  sourceSha: oldSha,
  runId: 10,
  published: { api: dig(1), caddy: dig(2), gotenberg: dig(3) },
});
const record = {
  id: 10,
  head_sha: oldSha,
  head_branch: 'main',
  conclusion: 'success',
  event: 'push',
  path: '.github/workflows/ci.yml',
  repository: { full_name: repository },
};

test('versioned manifest reuses exact digests and retains their producer evidence', () => {
  const mixed = createManifest({
    repository,
    sourceSha: newSha,
    runId: 11,
    previous,
    published: { api: dig(4) },
  });
  assert.deepEqual(mixed.images.caddy, previous.images.caddy);
  assert.equal(mixed.images.api.sourceSha, newSha);
  assert.equal(mixed.images.api.digest, dig(4));
  assert.equal(mixed.images.api.runId, 11);
  assert.equal(mixed.sourceSha, newSha);
});

test('invalid schema, repository, source, missing components and mutable tags fail closed', () => {
  for (const patch of [
    { version: 2 },
    { repository: 'attacker/repo' },
    { sourceSha: 'main' },
    { runId: 0 },
    { images: { api: previous.images.api } },
  ])
    assert.throws(() =>
      validateManifest({ ...previous, ...patch }, repository),
    );
  for (const patch of [
    { digest: 'latest' },
    { digest: '' },
    { repository: 'ghcr.io/attacker/repo' },
    { sourceSha: 'main' },
    { runId: 0 },
  ])
    assert.throws(() =>
      validateManifest(
        {
          ...previous,
          images: {
            ...previous.images,
            api: { ...previous.images.api, ...patch },
          },
        },
        repository,
      ),
    );
  assert.throws(() =>
    createManifest({
      repository,
      sourceSha: newSha,
      runId: 11,
      published: { api: dig(4) },
    }),
  );
});

test('release evidence must be successful main CI and an ancestor', () => {
  validateEvidence(previous, record, repository, () => true);
  for (const patch of [
    { conclusion: 'failure' },
    { head_branch: 'feature' },
    { head_sha: newSha },
    { event: 'pull_request' },
    { path: '.github/workflows/untrusted.yml' },
    { id: 12 },
    { repository: { full_name: 'attacker/repo' } },
  ])
    assert.throws(() =>
      validateEvidence(
        previous,
        { ...record, ...patch },
        repository,
        () => true,
      ),
    );
  assert.throws(() =>
    validateEvidence(previous, record, repository, () => false),
  );
});

test('reuse checks registry, exact main identity, SBOM and source-bound provenance', () => {
  const calls = [];
  const runner = (cmd, args) => {
    calls.push([cmd, args]);
    return cmd === 'gh' && args[0] === 'api' ? JSON.stringify(record) : '';
  };
  verifyImages(previous, repository, newSha, runner);
  assert.equal(calls.filter(([cmd]) => cmd === 'docker').length, 3);
  assert.equal(
    calls.filter(([cmd, args]) => cmd === 'cosign' && args[0] === 'verify')
      .length,
    3,
  );
  assert.equal(
    calls.filter(
      ([cmd, args]) => cmd === 'cosign' && args[0] === 'verify-attestation',
    ).length,
    3,
  );
  assert.equal(
    calls.filter(
      ([cmd, args]) =>
        cmd === 'gh' &&
        args.includes('--source-digest') &&
        args.includes(oldSha),
    ).length,
    3,
  );
  assert.ok(
    calls.find(
      ([cmd, args]) =>
        cmd === 'cosign' &&
        args.includes(
          'https://github.com/owner/repo/.github/workflows/ci.yml@refs/heads/main',
        ),
    ),
  );
  for (const fail of ['docker', 'cosign', 'gh'])
    assert.throws(() =>
      verifyImages(previous, repository, newSha, (cmd, args) => {
        if (cmd === fail && !(cmd === 'gh' && args[0] === 'api'))
          throw Error('registry/signature/provenance failure');
        return cmd === 'gh' && args[0] === 'api' ? JSON.stringify(record) : '';
      }),
    );
});

test('missing/expired trust evidence requires bootstrap, never a mutable fallback', () => {
  assert.throws(
    () =>
      trustedManifest(repository, newSha, () =>
        JSON.stringify({ workflow_runs: [] }),
      ),
    /bootstrap/,
  );
  assert.throws(
    () =>
      trustedManifest(repository, newSha, (cmd, args) =>
        JSON.stringify(
          args[1].includes('/artifacts?')
            ? { artifacts: [{ name: 'release-manifest-v1', expired: true }] }
            : { workflow_runs: [record] },
        ),
      ),
    /expired/,
  );
});

test('cumulative image routing includes failed intervening releases', () => {
  const calls = [];
  const files = gitFiles(oldSha, newSha, (cmd, args) => {
    calls.push(args);
    return 'apps/web/src/failed-release.tsx\0apps/api/src/next.ts\0';
  });
  const cumulative = classify({ files });
  assert.ok(cumulative.image && cumulative.caddy);
  assert.ok(!cumulative.gotenberg);
  assert.ok(calls[1].includes(oldSha));
  assert.equal(Object.keys(components).length, 3);
});
