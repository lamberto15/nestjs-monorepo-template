#!/usr/bin/env node
// `pnpm lint` runs this: every dependency of every workspace package.json is an
// exact version (AGENTS.md, "Newest versions, pinned"; Dependabot proposes the
// updates). A range (^, ~, >=, *, x, a hyphen or || range, a tag like `latest`)
// fails. `workspace:`, `catalog:`, `file:`, `link:` and git specifiers are not
// registry versions and pass; `npm:name@1.2.3` aliases must be exact too.
// `engines`, `devEngines` and `peerDependencies` are ranges by design: not checked.
// Also: pnpm's own version is the same in `devEngines.packageManager` (what
// `pnpm install` and CI run) and in the Dockerfiles' `ghcr.io/pnpm/pnpm` image
// (what builds the images); Dependabot raises only the images (#1000, #1069).
// Custom code: pnpm has no setting that rejects ranges in package.json.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies'];
const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export function isExact(specifier) {
  if (/^(?:workspace|catalog|file|link|git\+|github|https?):/.test(specifier))
    return true;
  if (specifier.startsWith('npm:')) {
    return EXACT.test(specifier.slice(specifier.lastIndexOf('@') + 1));
  }
  return EXACT.test(specifier);
}

// The ranges in one parsed package.json, as "section name@specifier" lines.
export function rangesOf(pkg) {
  return SECTIONS.flatMap((section) =>
    Object.entries(pkg[section] ?? {})
      .filter(([, specifier]) => !isExact(specifier))
      .map(([name, specifier]) => `${section}: ${name}@${specifier}`),
  );
}

// The root and the workspace's `apps/*` and `packages/*` packages.
export function manifests(dir = root) {
  const out = [join(dir, 'package.json')];
  for (const group of ['apps', 'packages']) {
    if (!existsSync(join(dir, group))) continue;
    for (const entry of readdirSync(join(dir, group), {
      withFileTypes: true,
    })) {
      const file = join(dir, group, entry.name, 'package.json');
      if (entry.isDirectory() && existsSync(file)) out.push(file);
    }
  }
  return out;
}

export function check(dir = root) {
  return manifests(dir).flatMap((file) =>
    rangesOf(JSON.parse(readFileSync(file, 'utf8'))).map(
      (r) => `${file.slice(dir.length + 1)} ${r}`,
    ),
  );
}

// The Dockerfiles that build from the pnpm image.
export const PNPM_DOCKERFILES = ['apps/api/Dockerfile', 'caddy/Dockerfile'];
const PNPM_IMAGE = /^FROM ghcr\.io\/pnpm\/pnpm:(\S+)/gm;

// Where pnpm's version disagrees with the root's devEngines.packageManager:
// one line per Dockerfile image tag (and a line when the root names none).
export function pnpmVersionProblems(dir = root) {
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const expected = pkg.devEngines?.packageManager?.version;
  if (typeof expected !== 'string') {
    return ['package.json: devEngines.packageManager.version is not set'];
  }
  return PNPM_DOCKERFILES.flatMap((file) => {
    const path = join(dir, file);
    if (!existsSync(path)) return [];
    return [...readFileSync(path, 'utf8').matchAll(PNPM_IMAGE)]
      .map((match) => match[1])
      .filter((tag) => tag !== expected)
      .map(
        (tag) =>
          `${file}: ghcr.io/pnpm/pnpm:${tag} but package.json devEngines names pnpm ${expected}`,
      );
  });
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const problems = check();
  if (problems.length) {
    problems.forEach((p) => process.stderr.write(`pinned-deps: ${p}\n`));
    process.stderr.write(
      'pinned-deps: use the exact version (pnpm add saves it; saveExact in pnpm-workspace.yaml)\n',
    );
    process.exitCode = 1;
  }
  const pnpm = pnpmVersionProblems();
  if (pnpm.length) {
    pnpm.forEach((p) => process.stderr.write(`pinned-deps: ${p}\n`));
    process.stderr.write(
      'pinned-deps: pnpm is pinned in package.json (devEngines) and in the Dockerfiles: raise them together (docs/development.md, "Dependencies are pinned")\n',
    );
    process.exitCode = 1;
  }
  if (!problems.length && !pnpm.length) {
    const { devEngines } = JSON.parse(
      readFileSync(join(root, 'package.json'), 'utf8'),
    );
    process.stdout.write(
      `pinned-deps: ${manifests().length} package.json files, no ranges; pnpm ${devEngines.packageManager.version} in devEngines and the Dockerfiles\n`,
    );
  }
}
