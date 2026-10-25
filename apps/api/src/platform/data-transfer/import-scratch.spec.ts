import { randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createImportScratchDirectory,
  scratchOwnerIsStale,
} from './import-scratch.js';

describe('createImportScratchDirectory', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'import-scratch-test-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('keeps live owners and removes stale feature directories only', async () => {
    const live = await createImportScratchDirectory(root, 'data-import');
    const stale = join(
      root,
      `transfer-xlsx-2147483647-0000000000000000-${randomUUID()}`,
    );
    const unrelated = join(root, `other-2147483647-${randomUUID()}`);
    await Promise.all([
      mkdir(stale, { mode: 0o700 }),
      mkdir(unrelated, { mode: 0o700 }),
    ]);
    await writeFile(join(stale, 'scratch'), 'temporary');
    await writeFile(join(unrelated, 'keep'), 'keep');

    const created = await createImportScratchDirectory(root, 'data-import');

    expect((await lstat(live)).isDirectory()).toBe(true);
    await expect(lstat(stale)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(unrelated, 'keep'), 'utf8')).resolves.toBe(
      'keep',
    );
    expect((await lstat(created)).mode & 0o777).toBe(0o700);
  });

  it('removes symlinks without following them while reaping stale directories', async () => {
    const stale = join(
      root,
      `data-import-2147483647-0000000000000000-${randomUUID()}`,
    );
    const target = join(root, 'outside');
    const marker = join(target, 'keep');
    await mkdir(stale, { mode: 0o700 });
    await mkdir(target, { mode: 0o700 });
    await writeFile(marker, 'keep');
    await symlink(target, join(stale, 'linked-target'));

    await createImportScratchDirectory(root, 'transfer-xlsx');

    await expect(lstat(stale)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(marker, 'utf8')).resolves.toBe('keep');
  });

  it('reaps a directory whose PID has been reused by another Linux process', async () => {
    if (process.platform !== 'linux') return;
    const stale = join(
      root,
      `data-import-${process.pid}-0000000000000000-${randomUUID()}`,
    );
    await mkdir(stale, { mode: 0o700 });

    await createImportScratchDirectory(root, 'transfer-xlsx');

    await expect(lstat(stale)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('uses process identity to distinguish a reused PID from a live owner', async () => {
    const exists = vi.fn(() => true);
    const identity = vi.fn(async () => 'new-process-start');

    await expect(
      scratchOwnerIsStale(123, 'old-process-start', { exists, identity }),
    ).resolves.toBe(true);
    await expect(
      scratchOwnerIsStale(123, 'new-process-start', { exists, identity }),
    ).resolves.toBe(false);
    await expect(
      scratchOwnerIsStale(123, 'unknown', { exists, identity }),
    ).resolves.toBe(false);
  });

  it('rejects a symlink as the configured scratch root', async () => {
    const target = join(root, 'real-root');
    const link = join(root, 'linked-root');
    await mkdir(target, { mode: 0o700 });
    await symlink(target, link);

    await expect(
      createImportScratchDirectory(link, 'data-import'),
    ).rejects.toThrow('must be a real directory');
  });
});
