import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promotion } from './release-promote.mjs';

const repository = 'owner/repo';
const tagged = 'a'.repeat(40);
const earlier = 'b'.repeat(40);
const later = 'c'.repeat(40);

// A fake git and gh: tags on commits, releases, CI runs and their artifacts.
function world({
  tags = { [tagged]: ['v1.2.0'] },
  releases = { 'v1.2.0': { isDraft: true } },
  onMain = [tagged, earlier],
  runs = [
    { id: 30, event: 'push', head_sha: later },
    { id: 20, event: 'push', head_sha: tagged },
    { id: 10, event: 'push', head_sha: earlier },
  ],
  manifests = [20, 10],
} = {}) {
  const ancestors = { [tagged]: [tagged, earlier], [earlier]: [earlier] };
  return (command, args) => {
    if (command === 'git' && args[0] === 'tag')
      return (tags[args[2]] ?? []).join('\n');
    if (command === 'git' && args[0] === 'rev-parse') {
      const tag = /^refs\/tags\/(.+)\^\{commit\}$/.exec(args[1])[1];
      const sha = Object.keys(tags).find((s) => tags[s].includes(tag));
      if (!sha) throw new Error('unknown revision');
      return sha + '\n';
    }
    if (command === 'git' && args[0] === 'merge-base') {
      const [, , ancestor, head] = args;
      const ok =
        head === 'origin/main'
          ? onMain.includes(ancestor)
          : (ancestors[head] ?? []).includes(ancestor);
      if (!ok) throw new Error('not an ancestor');
      return '';
    }
    if (command === 'gh' && args[0] === 'release') {
      if (!releases[args[2]]) throw new Error('release not found');
      return JSON.stringify(releases[args[2]]);
    }
    if (command === 'gh' && args[1].includes('/workflows/ci.yml/runs'))
      return JSON.stringify({ workflow_runs: runs });
    if (command === 'gh' && args[1].includes('/artifacts')) {
      const id = Number(args[1].split('/runs/')[1].split('/')[0]);
      return JSON.stringify({
        artifacts: manifests.includes(id)
          ? [{ name: 'release-manifest-v1', expired: false }]
          : [],
      });
    }
    throw new Error(`unexpected ${command} ${args.join(' ')}`);
  };
}

test("after CI, the tag on the run's commit is promoted with that run's images", () => {
  const plan = promotion(
    { repository, event: 'workflow_run', headSha: tagged },
    world(),
  );
  assert.deepEqual(plan, {
    tag: 'v1.2.0',
    sha: tagged,
    state: 'draft',
    version: '1.2.0',
    prerelease: false,
    runId: '20',
  });
});

test('after CI, nothing to do without a tag or once the release is published', () => {
  const event = { repository, event: 'workflow_run' };
  assert.equal(promotion({ ...event, headSha: earlier }, world()), null);
  assert.equal(
    promotion(
      { ...event, headSha: tagged },
      world({ releases: { 'v1.2.0': { isDraft: false } } }),
    ),
    null,
  );
  assert.throws(
    () =>
      promotion(
        { ...event, headSha: tagged },
        world({ tags: { [tagged]: ['v1.2.0', 'v1.2.1'] } }),
      ),
    /More than one release tag/,
  );
});

test('by hand: a hand-made tag, a pre-release, and a commit CI skipped', () => {
  const plan = promotion(
    { repository, event: 'workflow_dispatch', tag: 'v1.3.0-rc.1' },
    world({
      tags: { [tagged]: ['v1.3.0-rc.1'] },
      releases: {},
      manifests: [10],
    }),
  );
  assert.equal(plan.state, 'none');
  assert.equal(plan.prerelease, true);
  // No manifest on the tag's own run: the newest main run before it.
  assert.equal(plan.runId, '10');
});

test('a tag that is not a release tag, not on main, or without CI evidence is refused', () => {
  const event = { repository, event: 'workflow_dispatch' };
  for (const tag of [undefined, 'main', 'v1.2', 'v1.2.0 --repo x/y'])
    assert.throws(
      () => promotion({ ...event, tag }, world()),
      /Not a release tag/,
    );
  assert.throws(
    () => promotion({ ...event, tag: 'v1.2.0' }, world({ onMain: [earlier] })),
    /not on main/,
  );
  assert.throws(
    () => promotion({ ...event, tag: 'v1.2.0' }, world({ manifests: [30] })),
    /No successful main CI run/,
  );
});
