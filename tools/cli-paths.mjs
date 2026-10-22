// Where the repository's command-line tools may read and write what their
// arguments name (#471). Claude runs these tools itself (the /add-feature
// skill runs `pnpm feature:add`; deploys and releases too), so a wrong or
// hostile argument must not reach a file outside the directory meant for it.
// node:path resolves and joins but has no "stays under this directory" check,
// and a check on the text alone lets a symlink under an allowed directory
// lead anywhere: hence these few lines, each path checked by its text, then
// with its symlinks followed (real()). Each tool calls them at its entry
// point.
import { lstatSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `file` resolved with every symlink in it followed: realpathSync on the
 * longest part that exists, the part not created yet appended. Throws on a
 * symlink that leads nowhere: writing through it would create its target,
 * wherever that is.
 */
function real(file) {
  const rest = [];
  let head = path.resolve(file);
  for (;;) {
    try {
      return path.join(realpathSync(head), ...rest);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (lstatSync(head, { throwIfNoEntry: false })) {
        throw new Error(`${head}: a symlink to nothing; refused.`);
      }
      const parent = path.dirname(head);
      if (parent === head) throw error;
      rest.unshift(path.basename(head));
      head = parent;
    }
  }
}

/** The repository these tools belong to. */
export const REPO = real(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
);

/** real(), or null where it fails (a symlink to nothing, a file in the way). */
function realOrNull(file) {
  try {
    return real(file);
  } catch {
    return null;
  }
}

/**
 * `segments` resolved under `root`; throws unless the result stays inside
 * it (a `..` or an absolute segment that leaves it fails), by its text and
 * then with its symlinks followed (a symlink that leads out fails too).
 * Returns the path with its symlinks followed.
 */
export function inside(root, ...segments) {
  const base = path.resolve(root);
  const full = path.resolve(base, ...segments);
  if (!full.startsWith(base + path.sep)) {
    throw new Error(`${path.join(...segments)}: outside ${base}; refused.`);
  }
  const realFull = real(full);
  if (!realFull.startsWith(real(base) + path.sep)) {
    throw new Error(
      `${path.join(...segments)}: outside ${base} through a symlink; refused.`,
    );
  }
  return realFull;
}

/**
 * The system's temp directory, CI's (RUNNER_TEMP, which holds the workflows'
 * step summaries and release notes) and, on Unix, /tmp: on macOS
 * os.tmpdir() is the per-user $TMPDIR (/var/folders/…/T), and /tmp is where
 * the docs' runs write (LOADTEST_OUT=/tmp/lt4).
 */
export function tempRoots(env = process.env, platform = process.platform) {
  const dirs = [tmpdir(), env.RUNNER_TEMP, platform === 'win32' ? '' : '/tmp'];
  return [...new Set(dirs.filter(Boolean).map((dir) => path.resolve(dir)))];
}

/**
 * The directories a tool's own input files may be in: this checkout and
 * the temp directories.
 */
export function fileRoots(env = process.env) {
  return [REPO, ...tempRoots(env)];
}

/**
 * `file` (an argument) with its symlinks followed, when it is inside one of
 * `roots` by its text and still once they are followed; else null.
 */
export function within(file, roots = fileRoots()) {
  if (typeof file !== 'string' || file === '') return null;
  const full = path.resolve(file);
  for (const root of roots) {
    const base = path.resolve(root);
    if (full.startsWith(base + path.sep)) {
      const realFull = realOrNull(full);
      const realBase = realOrNull(base);
      if (realFull && realBase && realFull.startsWith(realBase + path.sep)) {
        return realFull;
      }
    }
  }
  return null;
}

/**
 * A file a tool writes (release notes, step summaries, annotations), when it
 * is under a temp directory and outside this checkout; else null. CI writes
 * them to RUNNER_TEMP; in a checkout, a write could replace a git hook or a
 * script that runs later.
 */
export function outputFile(file, env = process.env) {
  const full = within(file, tempRoots(env));
  return full && !within(full, [REPO]) ? full : null;
}
