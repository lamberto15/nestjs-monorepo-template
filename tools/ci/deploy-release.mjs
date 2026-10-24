// Deployments select existing CI evidence rather than rebuilding an image or
// resolving mutable tags. The artifact and every image remain independently checked.
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { githubCli } from './github-cli.mjs';
import { validateEvidence, verifyImages } from './release-manifest.mjs';

const execute = (command, args) =>
  execFileSync(command === 'gh' ? githubCli() : command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

export function releaseRunId(value) {
  if (
    typeof value !== 'string' ||
    !/^[1-9]\d*$/.test(value) ||
    !Number.isSafeInteger(Number(value))
  )
    throw new Error('Release run ID must be a positive safe integer');
  return value;
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
  const manifest = deploymentManifest(
    process.env.GITHUB_REPOSITORY,
    process.env.RELEASE_RUN_ID,
    process.env.GITHUB_SHA,
  );
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `source_sha=${manifest.sourceSha}\n` +
      Object.entries(manifest.images)
        .map(([key, image]) => `${key}=${image.digest}\n`)
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
