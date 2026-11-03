// Promotes a release tag (docs/releases.md, "How a release is made"): never a
// build. The tag's images are the ones CI / CD built and signed on main for
// the tag's commit (or, for a commit CI skipped, the newest main run before
// it); release.yml checks them as a deploy does (deploy-release.mjs), adds the
// version tags and publishes the GitHub release that Release Please drafted.
//
//   after CI / CD on main   the v* tag on the run's commit, if there is one
//                           and its release is not published yet
//   by hand                 the tag given (a retry, or a tag made by hand)
import { appendFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { execute } from './github-cli.mjs';
import { deploymentManifest } from './deploy-release.mjs';

const TAG = /^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const SHA = /^[a-f0-9]{40}$/;
const succeeds = (fn) => {
  try {
    fn();
    return true;
  } catch {
    return false;
  }
};

/** The release tag on a commit, or null; two would be ambiguous. */
function tagAt(sha, run) {
  const tags = run('git', ['tag', '--points-at', sha])
    .split('\n')
    .map((tag) => tag.trim())
    .filter((tag) => TAG.test(tag));
  if (tags.length > 1)
    throw new Error(`More than one release tag on ${sha}: ${tags.join(', ')}`);
  return tags[0] ?? null;
}

/** draft, published or none: `gh release view` also finds drafts. */
function releaseState(tag, run) {
  let release;
  try {
    release = JSON.parse(
      run('gh', ['release', 'view', tag, '--json', 'isDraft']),
    );
  } catch {
    return 'none';
  }
  return release.isDraft ? 'draft' : 'published';
}

/** The newest successful main CI run with a release manifest, up to `sha`. */
function releaseRun(repository, sha, run) {
  const { workflow_runs: runs = [] } = JSON.parse(
    run('gh', [
      'api',
      `repos/${repository}/actions/workflows/ci.yml/runs?branch=main&status=success&per_page=100`,
    ]),
  );
  for (const record of runs) {
    if (!['push', 'workflow_dispatch'].includes(record.event)) continue;
    if (!SHA.test(record.head_sha ?? '')) continue;
    if (
      !succeeds(() =>
        run('git', ['merge-base', '--is-ancestor', record.head_sha, sha]),
      )
    )
      continue;
    const { artifacts = [] } = JSON.parse(
      run('gh', [
        'api',
        `repos/${repository}/actions/runs/${record.id}/artifacts?name=release-manifest-v1`,
      ]),
    );
    if (
      artifacts.some(
        (artifact) =>
          artifact.name === 'release-manifest-v1' && !artifact.expired,
      )
    )
      return String(record.id);
  }
  throw new Error(
    `No successful main CI run with a release manifest up to ${sha}`,
  );
}

/** What release.yml promotes, or null when there is nothing to do. */
export function promotion({ repository, event, tag, headSha }, run = execute) {
  if (event === 'workflow_run') {
    if (!SHA.test(headSha ?? '')) throw new Error(`Not a commit: ${headSha}`);
    tag = tagAt(headSha, run);
    if (!tag) return null;
  } else if (typeof tag !== 'string' || !TAG.test(tag)) {
    throw new Error(`Not a release tag: ${tag}`);
  }
  const state = releaseState(tag, run);
  // CI re-run on an already released commit: nothing to promote.
  if (event === 'workflow_run' && state === 'published') return null;
  const sha = run('git', ['rev-parse', `refs/tags/${tag}^{commit}`]).trim();
  if (!SHA.test(sha)) throw new Error(`No commit for ${tag}`);
  if (
    !succeeds(() =>
      run('git', ['merge-base', '--is-ancestor', sha, 'origin/main']),
    )
  )
    throw new Error(`${tag} (${sha}) is not on main`);
  return {
    tag,
    sha,
    state,
    version: tag.slice(1),
    prerelease: tag.includes('-'),
    runId: releaseRun(repository, sha, run),
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const repository = process.env.GITHUB_REPOSITORY;
  const plan = promotion({
    repository,
    event: process.env.GITHUB_EVENT_NAME,
    tag: process.env.PROMOTE_TAG || undefined,
    headSha: process.env.HEAD_SHA,
  });
  if (plan === null) {
    appendFileSync(process.env.GITHUB_OUTPUT, 'skip=true\n');
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      'Nothing to promote: no unreleased v* tag on this commit.\n',
    );
  } else {
    // The same checks as a deploy: the run's evidence, the source an
    // ancestor of the tag, every image's signature and attestations.
    const manifest = deploymentManifest(repository, plan.runId, plan.sha);
    writeFileSync('release-manifest.json', JSON.stringify(manifest, null, 2));
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      [
        'skip=false',
        `tag=${plan.tag}`,
        `version=${plan.version}`,
        `prerelease=${plan.prerelease}`,
        `state=${plan.state}`,
        ...Object.entries(manifest.images).flatMap(([key, image]) => [
          `${key}=${image.repository}@${image.digest}`,
          `${key}_digest=${image.digest}`,
        ]),
      ].join('\n') + '\n',
    );
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `### Promoting ${plan.tag}\n\nCommit \`${plan.sha}\`, images of CI run ${plan.runId}.\n`,
    );
  }
}
