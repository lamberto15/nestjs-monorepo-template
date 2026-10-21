import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { dumpTarget } from './openapi-dump-target.js';

/** `pnpm openapi:dump [file]` writes only a .json in the repository or the temp directory (#471). */
describe('dumpTarget', () => {
  // This file is apps/api/src/openapi-dump-target.spec.ts.
  const repo = resolve(import.meta.dirname, '../../..');

  it("is the typed client's openapi.json without an argument", () => {
    expect(dumpTarget(undefined)).toBe(
      join(repo, 'packages/api-client/openapi.json'),
    );
  });

  it('takes a .json file in the repository or the temp directory', () => {
    const fresh = join(tmpdir(), 'api-client-x', 'openapi.json');
    expect(dumpTarget(fresh)).toBe(fresh);
    expect(dumpTarget(join(repo, 'tmp/openapi.json'))).toBe(
      join(repo, 'tmp/openapi.json'),
    );
  });

  it('refuses a file outside both, or one that is not .json', () => {
    for (const arg of [
      join(repo, '../outside.json'),
      join(tmpdir(), '../outside.json'),
      '/etc/openapi.json',
      join(repo, 'apps/api/src/main.ts'),
      repo,
    ]) {
      expect(() => dumpTarget(arg)).toThrow(/\.json file under/);
    }
  });

  it('refuses a path that only starts like a root', () => {
    expect(() =>
      dumpTarget('/srv/repo-other/openapi.json', ['/srv/repo']),
    ).toThrow(/\.json file under/);
    expect(dumpTarget('/srv/repo/..x.json', ['/srv/repo'])).toBe(
      '/srv/repo/..x.json',
    );
  });
});
