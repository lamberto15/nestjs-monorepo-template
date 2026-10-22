// Where the repository's command-line tools may read and write what their
// arguments name (#471). Claude runs these tools itself (the /add-feature
// skill runs `pnpm feature:add`; deploys and releases too), so a wrong or
// hostile argument must not reach a file outside the directory meant for it.
// node:path resolves and joins but has no "stays under this directory" check,
// hence these few lines; each tool calls them at its entry point.
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The repository these tools belong to. */
export const REPO = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

/**
 * `segments` resolved under `root`; throws unless the result stays inside
 * it (a `..` or an absolute segment that leaves it fails).
 */
export function inside(root, ...segments) {
  const base = path.resolve(root);
  const full = path.resolve(base, ...segments);
  if (!full.startsWith(base + path.sep)) {
    throw new Error(`${path.join(...segments)}: outside ${base}; refused.`);
  }
  return full;
}

/**
 * The system's temp directory and CI's (RUNNER_TEMP, which holds the
 * workflows' step summaries and release notes).
 */
export function tempRoots(env = process.env) {
  return [tmpdir(), env.RUNNER_TEMP].filter(Boolean);
}

/**
 * The directories a tool's own input and output files may be in: this
 * checkout and the temp directories.
 */
export function fileRoots(env = process.env) {
  return [REPO, ...tempRoots(env)];
}

/** `file` (an argument) resolved, when it is inside one of `roots`; else null. */
export function within(file, roots = fileRoots()) {
  if (typeof file !== 'string' || file === '') return null;
  const full = path.resolve(file);
  for (const root of roots) {
    const base = path.resolve(root);
    if (full.startsWith(base + path.sep)) return full;
  }
  return null;
}
