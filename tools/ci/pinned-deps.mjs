#!/usr/bin/env node
// `pnpm lint` runs this: every dependency of every workspace package.json is an
// exact version (AGENTS.md, "Newest versions, pinned"; Dependabot proposes the
// updates). A range (^, ~, >=, *, x, a hyphen or || range, a tag like `latest`)
// fails. `workspace:`, `catalog:`, `file:`, `link:` and git specifiers are not
// registry versions and pass; `npm:name@1.2.3` aliases must be exact too.
// `engines`, `devEngines` and `peerDependencies` are ranges by design: not checked.
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
  } else {
    process.stdout.write(
      `pinned-deps: ${manifests().length} package.json files, no ranges\n`,
    );
  }
}
