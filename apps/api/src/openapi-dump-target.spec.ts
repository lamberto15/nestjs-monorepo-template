import { mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
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
    expect(dumpTarget(fresh)).toBe(
      join(realpathSync(tmpdir()), 'api-client-x', 'openapi.json'),
    );
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

  // On macOS tmpdir() is the per-user $TMPDIR, not /tmp, where the docs' runs
  // write: /tmp is a temp directory too.
  it.skipIf(process.platform === 'win32')(
    'takes a .json under /tmp whatever TMPDIR says',
    () => {
      const elsewhere = mkdtempSync(join(tmpdir(), 'dump-tmpdir-'));
      vi.stubEnv('TMPDIR', elsewhere);
      try {
        expect(dumpTarget('/tmp/api-client-y/openapi.json')).toBe(
          join(realpathSync('/tmp'), 'api-client-y/openapi.json'),
        );
      } finally {
        vi.unstubAllEnvs();
        rmSync(elsewhere, { recursive: true, force: true });
      }
    },
  );

  // A symlink under a root, by its name, may lead anywhere: followed first.
  it('refuses a symlink that leads out of the roots, or to nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dump-links-'));
    try {
      symlinkSync(resolve(repo, '..'), join(dir, 'out'), 'dir');
      expect(() => dumpTarget(join(dir, 'out/openapi.json'))).toThrow(
        /\.json file under/,
      );
      symlinkSync(join(dir, 'missing/x.json'), join(dir, 'dangling.json'));
      expect(() => dumpTarget(join(dir, 'dangling.json'))).toThrow(
        /symlink to nothing/,
      );
      expect(dumpTarget(join(dir, 'openapi.json'))).toBe(
        join(realpathSync(dir), 'openapi.json'),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
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
