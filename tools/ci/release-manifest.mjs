import { githubCli } from './github-cli.mjs';
// The registry cannot establish whether a complete release passed CI. GitHub's
// successful workflow artifacts provide that evidence; signatures bind images.
import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  mkdtempSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const components = { api: '', caddy: '/caddy', gotenberg: '/gotenberg' };
const sha = /^[a-f0-9]{40}$/;
const digest = /^sha256:[a-f0-9]{64}$/;
const execute = (command, args) =>
  execFileSync(command === 'gh' ? githubCli() : command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

export function validateManifest(manifest, repository) {
  if (
    manifest?.version !== 1 ||
    manifest.repository !== repository ||
    !sha.test(manifest.sourceSha) ||
    !Number.isSafeInteger(manifest.runId) ||
    manifest.runId <= 0
  )
    throw new Error('Invalid release manifest identity');
  if (
    !manifest.images ||
    Object.keys(manifest.images)
      .sort((a, b) => a.localeCompare(b))
      .join() !==
      Object.keys(components)
        .sort((a, b) => a.localeCompare(b))
        .join()
  )
    throw new Error('Incomplete image set');
  for (const [key, suffix] of Object.entries(components)) {
    const image = manifest.images[key];
    if (
      image.repository !== `ghcr.io/${repository.toLowerCase()}${suffix}` ||
      !digest.test(image.digest) ||
      !sha.test(image.sourceSha) ||
      !Number.isSafeInteger(image.runId) ||
      image.runId <= 0
    )
      throw new Error(`Invalid ${key} digest or evidence`);
  }
  return manifest;
}

export function validateEvidence(manifest, run, repository, ancestor) {
  validateManifest(manifest, repository);
  if (
    run.id !== manifest.runId ||
    run.head_sha !== manifest.sourceSha ||
    run.conclusion !== 'success' ||
    run.head_branch !== 'main' ||
    !['push', 'workflow_dispatch'].includes(run.event) ||
    run.path !== '.github/workflows/ci.yml' ||
    run.repository?.full_name !== repository
  )
    throw new Error('Release evidence is not a successful main CI run');
  if (!ancestor(manifest.sourceSha))
    throw new Error('Release source is not an ancestor of this source');
}

export function trustedManifest(repository, head, run = execute) {
  const ancestor = (source) => {
    try {
      run('git', ['merge-base', '--is-ancestor', source, head]);
      return true;
    } catch {
      return false;
    }
  };
  // Search named artifacts first: legacy successful runs have no manifest.
  // A bounded lookup fails closed if all usable evidence expired.
  for (let page = 1; page <= 10; page++) {
    const data = JSON.parse(
      run('gh', [
        'api',
        `repos/${repository}/actions/artifacts?name=release-manifest-v1&per_page=100&page=${page}`,
      ]),
    );
    for (const artifact of data.artifacts) {
      const candidate = JSON.parse(
        run('gh', [
          'api',
          `repos/${repository}/actions/runs/${artifact.workflow_run.id}`,
        ]),
      );
      if (
        candidate.conclusion !== 'success' ||
        candidate.head_branch !== 'main' ||
        !['push', 'workflow_dispatch'].includes(candidate.event) ||
        candidate.path !== '.github/workflows/ci.yml'
      )
        continue;
      if (artifact.expired)
        throw new Error('Trusted manifest expired; bootstrap required');
      const dir = mkdtempSync(join(tmpdir(), 'ci-release-'));
      run('gh', [
        'run',
        'download',
        String(candidate.id),
        '--repo',
        repository,
        '--name',
        'release-manifest-v1',
        '--dir',
        dir,
      ]);
      const manifest = JSON.parse(
        readFileSync(join(dir, 'release-manifest.json'), 'utf8'),
      );
      validateEvidence(manifest, candidate, repository, ancestor);
      return manifest;
    }
    if (data.artifacts.length < 100) break;
  }
  throw new Error(
    'No trusted release manifest. Run CI on main with bootstrap_release=true after separate review.',
  );
}

export function verifyImages(manifest, repository, head, run = execute) {
  validateManifest(manifest, repository);
  const evidence = new Map();
  const identity = `https://github.com/${repository}/.github/workflows/ci.yml@refs/heads/main`;
  for (const image of Object.values(manifest.images)) {
    if (!evidence.has(image.runId)) {
      const record = JSON.parse(
        run('gh', ['api', `repos/${repository}/actions/runs/${image.runId}`]),
      );
      const producer = {
        ...manifest,
        sourceSha: image.sourceSha,
        runId: image.runId,
      };
      validateEvidence(producer, record, repository, (source) => {
        try {
          run('git', ['merge-base', '--is-ancestor', source, head]);
          return true;
        } catch {
          return false;
        }
      });
      evidence.set(image.runId, image.sourceSha);
    }
    if (evidence.get(image.runId) !== image.sourceSha)
      throw new Error('Inconsistent image producer');
    const ref = `${image.repository}@${image.digest}`;
    run('docker', ['manifest', 'inspect', ref]);
    run('cosign', [
      'verify',
      '--certificate-identity',
      identity,
      '--certificate-oidc-issuer',
      'https://token.actions.githubusercontent.com',
      ref,
    ]);
    run('cosign', [
      'verify-attestation',
      '--type',
      'cyclonedx',
      '--certificate-identity',
      identity,
      '--certificate-oidc-issuer',
      'https://token.actions.githubusercontent.com',
      ref,
    ]);
    run('gh', [
      'attestation',
      'verify',
      `oci://${ref}`,
      '--repo',
      repository,
      '--signer-workflow',
      `${repository}/.github/workflows/ci.yml`,
      '--source-digest',
      image.sourceSha,
      '--source-ref',
      'refs/heads/main',
    ]);
  }
}

export function createManifest({
  repository,
  sourceSha,
  runId,
  previous,
  published,
}) {
  if (previous) validateManifest(previous, repository);
  const images = {};
  for (const [key, suffix] of Object.entries(components)) {
    if (published[key])
      images[key] = {
        repository: `ghcr.io/${repository.toLowerCase()}${suffix}`,
        digest: published[key],
        sourceSha,
        runId,
      };
    else if (previous) images[key] = previous.images[key];
    else
      throw new Error(
        `Missing ${key} image; bootstrap must build the complete set`,
      );
  }
  return validateManifest(
    { version: 1, repository, sourceSha, runId, images },
    repository,
  );
}

export function releasePlan(
  outputs,
  env,
  event,
  classify,
  gitFiles,
  load = trustedManifest,
) {
  const bootstrap =
    env.GITHUB_EVENT_NAME === 'workflow_dispatch' &&
    event.inputs?.bootstrap_release === 'true' &&
    env.GITHUB_REF === 'refs/heads/main';
  const tag =
    env.GITHUB_EVENT_NAME === 'push' &&
    env.GITHUB_REF.startsWith('refs/tags/v');
  const publish =
    tag ||
    bootstrap ||
    (env.GITHUB_EVENT_NAME === 'push' &&
      env.GITHUB_REF === 'refs/heads/main' &&
      outputs.code);
  const plan = { publish, bootstrap, previous: null };
  if (publish && !tag && !bootstrap) {
    try {
      plan.previous = load(env.GITHUB_REPOSITORY, env.GITHUB_SHA);
      const files = gitFiles(plan.previous.sourceSha, env.GITHUB_SHA);
      const cumulative = classify({ files, complete: Boolean(files) });
      // Include changes from failed/skipped intervening releases, rather than
      // comparing images only with the immediately preceding source commit.
      // A failed validation cannot supply evidence for a rebuilt component.
      // Revalidate cumulative application changes, not just their image build.
      for (const [key, needed] of Object.entries(cumulative))
        outputs[key] ||= needed;
    } catch (error) {
      plan.error = error.message;
    }
  }

  if (tag || bootstrap)
    outputs.image =
      outputs.api_image =
      outputs.caddy =
      outputs.gotenberg =
        true;
  const directory = join(env.RUNNER_TEMP ?? tmpdir(), 'ci-release-plan');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'plan.json'), JSON.stringify(plan));
  return plan;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const plan = JSON.parse(readFileSync('release-plan/plan.json', 'utf8'));
  if (plan.error) throw new Error(plan.error);
  if (plan.previous)
    verifyImages(
      plan.previous,
      process.env.GITHUB_REPOSITORY,
      process.env.GITHUB_SHA,
    );
  const manifest = createManifest({
    repository: process.env.GITHUB_REPOSITORY,
    sourceSha: process.env.GITHUB_SHA,
    runId: Number(process.env.GITHUB_RUN_ID),
    previous: plan.previous,
    published: JSON.parse(process.env.PUBLISHED),
  });
  writeFileSync(
    'release-manifest.json',
    JSON.stringify(manifest, null, 2) + '\n',
  );
  for (const [key, image] of Object.entries(manifest.images)) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${image.digest}\n`);
  }
}
