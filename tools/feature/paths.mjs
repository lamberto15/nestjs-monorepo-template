// Where the feature tools (add, sync, remove) read and write (#471): the
// checkout `--root` names (this repository by default, or a copy of it in a
// temp directory), and inside it only. A feature's name becomes a folder and
// file names, so it is checked before any path is built from it.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { REPO, tempRoots, within } from '../cli-paths.mjs';

export { inside } from '../cli-paths.mjs';

/** A feature's folder name: plural, lowercase words joined by "-" (invoice-lines). */
export const FEATURE_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/**
 * `root` resolved with its symlinks followed, when it is this checkout, or a
 * copy of the template under a temp directory (the tools' tests and `pnpm
 * setup --root` work on such copies), and holds one of `markers`; throws
 * before anything is read or written otherwise. inside() keeps each path
 * under the root; this keeps the root itself to those places, so `--root`
 * (a symlink in a temp directory included) can't point the tools at
 * another tree on the machine.
 */
export function checkout(root, ...markers) {
  const full = path.resolve(root) === REPO ? REPO : within(root, tempRoots());
  if (full === null) {
    throw new Error(
      `--root ${root}: neither this checkout (${REPO}) nor a directory under ${tempRoots().join(' or ')} (symlinks followed); refused.`,
    );
  }
  if (!markers.some((marker) => existsSync(path.join(full, marker)))) {
    throw new Error(
      `${full} is not a checkout of the template (it has no ${markers.join(' or ')}): --root names the repository.`,
    );
  }
  return full;
}
