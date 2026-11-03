// Deployments select existing CI evidence rather than rebuilding an image or
// resolving mutable tags. The artifact and every image remain independently checked.
//
// Which CI run a Deploy run takes (deploymentRun):
//   staging, after CI on main      that run, when it kept a release manifest
//   staging, by hand               a release tag, or the newest such main run
//   production, only by hand       a release tag whose GitHub release is
//                                  published and not a pre-release
import { appendFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execute } from './github-cli.mjs';
import { validateEvidence, verifyImages } from './release-manifest.mjs';

export function releaseRunId(value) {
  if (
    typeof value !== 'string' ||
    !/^[1-9]\d*$/.test(value) ||
    !Number.isSafeInteger(Number(value))
  )
    throw new Error('Release run ID must be a positive safe integer');
  return value;
}

const ARTIFACT = 'release-manifest-v1';
const TAG = /^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const ENVIRONMENTS = new Set(['staging', 'production']);

/** Whether a CI run kept a release manifest (one that published nothing has none). */
function hasReleaseManifest(repository, value, run = execute) {
  const id = releaseRunId(value);
  const { artifacts = [] } = JSON.parse(
    run('gh', [
      'api',
      `repos/${repository}/actions/runs/${id}/artifacts?name=${ARTIFACT}`,
    ]),
  );
  return artifacts.some(
    (artifact) => artifact.name === ARTIFACT && !artifact.expired,
  );
}

/** The newest successful main CI run that kept a release manifest. */
function latestReleaseRun(repository, run = execute) {
  const { workflow_runs: runs = [] } = JSON.parse(
    run('gh', [
      'api',
      `repos/${repository}/actions/workflows/ci.yml/runs?branch=main&status=success&per_page=50`,
    ]),
  );
  for (const record of runs) {
    if (!['push', 'workflow_dispatch'].includes(record.event)) continue;
    if (hasReleaseManifest(repository, String(record.id), run))
      return String(record.id);
  }
  throw new Error('No successful main CI run with a release manifest');
}

/**
 * The CI run behind a release tag, from its GitHub release's
 * release-manifest.json. A draft (promotion unfinished) is refused, and so
 * is a pre-release for production.
 */
function tagReleaseRun(repository, tag, { production }, run = execute) {
  if (typeof tag !== 'string' || !TAG.test(tag))
    throw new Error(`Not a release tag: ${tag}`);
  const release = JSON.parse(
    run('gh', ['api', `repos/${repository}/releases/tags/${tag}`]),
  );
  if (release.tag_name !== tag) throw new Error(`No GitHub release for ${tag}`);
  if (release.draft)
    throw new Error(
      `${tag} is a draft release: its promotion has not finished`,
    );
  if (production && release.prerelease)
    throw new Error(
      `${tag} is a pre-release: production takes published releases only`,
    );
  if (!release.assets?.some((asset) => asset.name === 'release-manifest.json'))
    throw new Error(`${tag} has no release-manifest.json`);
  const directory = mkdtempSync(join(tmpdir(), 'deploy-tag-'));
  run('gh', [
    'release',
    'download',
    tag,
    '--repo',
    repository,
    '--pattern',
    'release-manifest.json',
    '--dir',
    directory,
  ]);
  const { runId } = JSON.parse(
    readFileSync(join(directory, 'release-manifest.json'), 'utf8'),
  );
  return releaseRunId(String(runId));
}

/** The CI run a Deploy run deploys, or null when there is nothing to deploy. */
export function deploymentRun(
  { repository, event, environment, tag, workflowRunId },
  run = execute,
) {
  if (!ENVIRONMENTS.has(environment))
    throw new Error(`Unknown environment: ${environment}`);
  if (environment === 'production') {
    // Production only by a person, whatever started this run.
    if (event !== 'workflow_dispatch')
      throw new Error('Production is deployed only by a manual Deploy run');
    if (!tag) throw new Error('Production needs a release tag');
  }
  if (event === 'workflow_run')
    return hasReleaseManifest(repository, workflowRunId, run)
      ? releaseRunId(workflowRunId)
      : null;
  if (tag)
    return tagReleaseRun(
      repository,
      tag,
      { production: environment === 'production' },
      run,
    );
  return latestReleaseRun(repository, run);
}

export function deploymentManifest(repository, value, head, run = execute) {
  const id = releaseRunId(value);
  const record = JSON.parse(
    run('gh', ['api', `repos/${repository}/actions/runs/${id}`]),
  );
  // Reject untrusted runs before downloading any artifact or reading images.
  if (
    record.id !== Number(id) ||
    record.conclusion !== 'success' ||
    record.head_branch !== 'main' ||
    !['push', 'workflow_dispatch'].includes(record.event) ||
    record.path !== '.github/workflows/ci.yml' ||
    record.repository?.full_name !== repository
  )
    throw new Error('Deployment requires a successful main CI release run');
  const directory = mkdtempSync(join(tmpdir(), 'deploy-release-'));
  run('gh', [
    'run',
    'download',
    id,
    '--repo',
    repository,
    '--name',
    'release-manifest-v1',
    '--dir',
    directory,
  ]);
  const manifest = JSON.parse(
    readFileSync(join(directory, 'release-manifest.json'), 'utf8'),
  );
  validateEvidence(manifest, record, repository, (source) => {
    try {
      run('git', ['merge-base', '--is-ancestor', source, head]);
      return true;
    } catch {
      return false;
    }
  });
  verifyImages(manifest, repository, head, run);
  return manifest;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  if (process.env.GITHUB_REF !== 'refs/heads/main')
    throw new Error('Deploy only from main');
  const id = deploymentRun({
    repository: process.env.GITHUB_REPOSITORY,
    event: process.env.GITHUB_EVENT_NAME,
    environment: process.env.DEPLOY_ENVIRONMENT,
    tag: process.env.DEPLOY_TAG || undefined,
    workflowRunId: process.env.WORKFLOW_RUN_ID,
  });
  if (id === null) {
    appendFileSync(process.env.GITHUB_OUTPUT, 'skip=true\n');
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      'Nothing to deploy: this CI run published no release manifest.\n',
    );
  } else {
    const manifest = deploymentManifest(
      process.env.GITHUB_REPOSITORY,
      id,
      process.env.GITHUB_SHA,
    );
    // Images as repository@digest, ready for the stack's *_IMAGE variables.
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `skip=false\nsource_sha=${manifest.sourceSha}\nrun_id=${manifest.runId}\n` +
        Object.entries(manifest.images)
          .map(([key, image]) => `${key}=${image.repository}@${image.digest}\n`)
          .join(''),
    );
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `### Verified deployment release\n\nSource: \`${manifest.sourceSha}\`\n\nRelease run: ${manifest.runId}\n\n` +
        Object.entries(manifest.images)
          .map(
            ([key, image]) =>
              `- ${key}: \`${image.repository}@${image.digest}\`\n`,
          )
          .join(''),
    );
  }
}
