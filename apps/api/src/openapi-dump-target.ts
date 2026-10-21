import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { appPath } from './app-dir.js';

/**
 * Where `pnpm openapi:dump` writes the OpenAPI document: the typed client's
 * openapi.json by default (`apps/api` → the repository's root), else the
 * file its argument names. That one must be a .json file in the repository
 * or in the system's temp directory (`pnpm client:check` dumps into one):
 * the script writes, and Claude runs it too, so a wrong argument must not
 * reach any other file (#471). Throws before anything is written.
 */
export function dumpTarget(
  arg: string | undefined,
  roots: readonly string[] = [appPath('../..'), tmpdir()],
): string {
  const target = resolve(
    arg ?? appPath('../../packages/api-client/openapi.json'),
  );
  const isUnder = (root: string) => {
    const rel = relative(resolve(root), target);
    return (
      rel !== '' &&
      rel !== '..' &&
      !rel.startsWith(`..${sep}`) &&
      !isAbsolute(rel)
    );
  };
  if (!target.endsWith('.json') || !roots.some(isUnder)) {
    throw new Error(
      `${target}: the document goes to a .json file under ${roots.join(' or ')}.`,
    );
  }
  return target;
}
