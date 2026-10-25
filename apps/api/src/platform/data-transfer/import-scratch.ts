import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const PREFIXES = ['data-import', 'transfer-xlsx'] as const;
const SCRATCH_NAME =
  /^(data-import|transfer-xlsx)-(\d+)-([a-f0-9]{16}|unknown)-([a-f0-9-]{36})$/;

function processExists(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** Linux process identity changes across PID reuse and container reboots. */
async function processIdentity(pid: number): Promise<string | undefined> {
  if (process.platform !== 'linux') return undefined;
  try {
    const [bootId, stat] = await Promise.all([
      readFile('/proc/sys/kernel/random/boot_id', 'utf8'),
      readFile(`/proc/${pid}/stat`, 'utf8'),
    ]);
    // The command field (2) is parenthesized and may contain spaces or ')'.
    // Start time is field 22, index 19 after the fields following its last ')'.
    const fields = stat
      .slice(stat.lastIndexOf(')') + 1)
      .trim()
      .split(/\s+/);
    const startTime = fields[19];
    if (!startTime) return undefined;
    return createHash('sha256')
      .update(`${bootId.trim()}:${startTime}`)
      .digest('hex')
      .slice(0, 16);
  } catch {
    return undefined;
  }
}

/** Testable PID liveness decision; identity mismatch proves PID reuse. */
export async function scratchOwnerIsStale(
  pid: number,
  identity: string,
  probes: {
    exists: (pid: number) => boolean;
    identity: (pid: number) => Promise<string | undefined>;
  } = { exists: processExists, identity: processIdentity },
) {
  const [exists, currentIdentity] = await Promise.all([
    Promise.resolve(probes.exists(pid)),
    probes.identity(pid),
  ]);
  return (
    !exists ||
    (identity !== 'unknown' &&
      !!currentIdentity &&
      currentIdentity !== identity)
  );
}

async function ensurePrivateRoot(path: string) {
  const root = resolve(path);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`Import scratch path must be a real directory: ${root}`);
  }
  if ((info.mode & 0o022) !== 0) {
    throw new Error(
      `Import scratch directory is writable by other users: ${root}`,
    );
  }
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
    throw new Error(
      `Import scratch directory must be owned by this process: ${root}`,
    );
  }
  return root;
}

/**
 * Remove only abandoned directories created by this feature. A process that
 * may still be using a directory is left alone; permission errors are treated
 * as evidence that its owner may still exist.
 */
async function removeAbandoned(root: string) {
  for (const name of await readdir(root)) {
    const match = SCRATCH_NAME.exec(name);
    if (!match || !PREFIXES.includes(match[1] as (typeof PREFIXES)[number])) {
      continue;
    }
    const pid = Number(match[2]);
    if (!Number.isSafeInteger(pid) || pid < 1) continue;
    // A reused PID is stale when Linux can establish that its process start
    // identity differs. On systems without /proc, only ESRCH proves staleness.
    if (!(await scratchOwnerIsStale(pid, match[3]!))) continue;
    const path = join(root, name);
    const info = await lstat(path).catch(() => undefined);
    if (
      !info ||
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (typeof process.getuid === 'function' && info.uid !== process.getuid()) ||
      (info.mode & 0o077) !== 0
    ) {
      continue;
    }
    // fs.rm removes symlinks as entries; it does not traverse their targets.
    await rm(path, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Create one private scratch directory after reaping provably dead owners. */
export async function createImportScratchDirectory(
  path: string,
  prefix: (typeof PREFIXES)[number],
) {
  const root = await ensurePrivateRoot(path);
  await removeAbandoned(root);
  const identity = (await processIdentity(process.pid)) ?? 'unknown';
  const directory = join(
    root,
    `${prefix}-${process.pid}-${identity}-${randomUUID()}`,
  );
  await mkdir(directory, { mode: 0o700 });
  return directory;
}
