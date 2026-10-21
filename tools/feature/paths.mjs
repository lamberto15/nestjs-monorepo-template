// Where the feature tools (add, sync, remove) read and write (#471): the
// checkout `--root` names (this repository by default), and inside it only.
// A feature's name becomes a folder and file names, so it is checked before
// any path is built from it.
import { existsSync } from 'node:fs';
import path from 'node:path';

export { inside } from '../cli-paths.mjs';

/** A feature's folder name: plural, lowercase words joined by "-" (invoice-lines). */
export const FEATURE_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/**
 * `root` resolved, when it is a checkout of the template (it holds one of
 * `markers`); throws before anything is read or written otherwise.
 */
export function checkout(root, ...markers) {
  const full = path.resolve(root);
  if (!markers.some((marker) => existsSync(path.join(full, marker)))) {
    throw new Error(
      `${full} is not a checkout of the template (it has no ${markers.join(' or ')}): --root names the repository.`,
    );
  }
  return full;
}
