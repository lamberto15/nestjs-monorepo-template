import { lstatSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { appPath } from './app-dir.js';

/**
 * The temp directories a dump may go to: the system's and, on Unix, /tmp
 * (on macOS the system's is the per-user $TMPDIR, /var/folders/…/T).
 */
const tempDirs = () => [
  ...new Set([tmpdir(), ...(process.platform === 'win32' ? [] : ['/tmp'])]),
];

/**
 * Where `pnpm openapi:dump` writes the OpenAPI document: the typed client's
 * openapi.json by default (`apps/api` → the repository's root), else the
 * file its argument names. That one must be a .json file in the repository
 * or in a temp directory (`pnpm client:check` dumps into one): the script
 * writes, and Claude runs it too, so a wrong argument must not reach any
 * other file (#471). Checked by its text, then with its symlinks followed,
 * as tools/cli-paths.mjs does: a symlink under a root may lead anywhere.
 * Throws before anything is written.
 */
export function dumpTarget(
  arg: string | undefined,
  roots: readonly string[] = [appPath('../..'), ...tempDirs()],
): string {
  const target = resolve(
    arg ?? appPath('../../packages/api-client/openapi.json'),
  );
  const refused = () =>
    new Error(
      `${target}: the document goes to a .json file under ${roots.join(' or ')}.`,
    );
  if (
    !target.endsWith('.json') ||
    !roots.some((root) => isUnder(root, target))
  ) {
    throw refused();
  }
  const full = real(target);
  if (
    !full.endsWith('.json') ||
    !roots.some((root) => isUnder(real(root), full))
  ) {
    throw refused();
  }
  return full;
}

/** Whether `file` is inside `root` (not the root itself). */
function isUnder(root: string, file: string): boolean {
  const rel = relative(resolve(root), file);
  return (
    rel !== '' &&
    rel !== '..' &&
    !rel.startsWith(`..${sep}`) &&
    !isAbsolute(rel)
  );
}

/**
 * `file` resolved with its symlinks followed: realpathSync on the longest
 * part that exists, the rest (not created yet) appended. A symlink to
 * nothing is refused: writing through it would create its target.
 */
function real(file: string): string {
  const rest: string[] = [];
  let head = resolve(file);
  for (;;) {
    try {
      return join(realpathSync(head), ...rest);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (lstatSync(head, { throwIfNoEntry: false })) {
        throw new Error(`${head}: a symlink to nothing; refused.`);
      }
      const parent = dirname(head);
      if (parent === head) throw error;
      rest.unshift(basename(head));
      head = parent;
    }
  }
}
