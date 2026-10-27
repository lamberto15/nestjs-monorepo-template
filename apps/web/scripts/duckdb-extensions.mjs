// Vendors DuckDB-Wasm's official, signed json and parquet extensions, so the
// analytics page serves them from its own origin and no request leaves the site.
// DuckDB documents this route: `SET custom_extension_repository = '<url>'`, files
// at `<repo>/v<duckdb version>/<platform>/<name>.duckdb_extension.wasm`
// (https://duckdb.org/docs/1.4/clients/wasm/extensions.html).
//
//   node scripts/duckdb-extensions.mjs           download what is missing or wrong, verify
//   node scripts/duckdb-extensions.mjs --check   verify the committed files offline
//   node scripts/duckdb-extensions.mjs --record  download everything and rewrite the pinned hashes
//
// The version and the SHA-256 pins live in
// src/features/analytics/duckdb-extensions.json, which the engine also imports.
// After a duckdb-wasm bump that changes the DuckDB version: edit "duckdbVersion",
// run with --record, review the diff, commit the new files and drop the old folder.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const webRoot = fileURLToPath(new URL('..', import.meta.url));
const configPath = join(
  webRoot,
  'src/features/analytics/duckdb-extensions.json',
);
const outputRoot = join(webRoot, 'public/duckdb-extensions');
const upstream = 'https://extensions.duckdb.org';

const config = JSON.parse(await readFile(configPath, 'utf8'));
const mode = process.argv[2];
if (mode && mode !== '--check' && mode !== '--record') {
  throw new Error(`Unknown option: ${mode}`);
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const files = config.platforms.flatMap((platform) =>
  config.extensions.map((name) => {
    const key = `${platform}/${name}`;
    return {
      key,
      url: `${upstream}/v${config.duckdbVersion}/${platform}/${name}.duckdb_extension.wasm`,
      path: join(
        outputRoot,
        `v${config.duckdbVersion}`,
        platform,
        `${name}.duckdb_extension.wasm`,
      ),
    };
  }),
);

const pins = { ...config.sha256 };
const problems = [];
for (const file of files) {
  let bytes = existsSync(file.path) ? await readFile(file.path) : undefined;
  const pinned = config.sha256[file.key];
  const good = bytes && pinned && sha256(bytes) === pinned;
  if (mode === '--check') {
    if (!good) problems.push(`${file.key}: missing, unpinned or modified`);
    continue;
  }
  if (mode === '--record' || !good) {
    const response = await fetch(file.url);
    if (!response.ok) throw new Error(`${file.url}: HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.subarray(0, 4).toString('latin1') !== '\0asm') {
      throw new Error(`${file.url}: not a WebAssembly file`);
    }
    if (mode === '--record') pins[file.key] = sha256(bytes);
    else if (!pinned) {
      problems.push(`${file.key}: no pinned SHA-256 (run with --record)`);
      continue;
    } else if (sha256(bytes) !== pinned) {
      problems.push(`${file.key}: downloaded SHA-256 differs from the pin`);
      continue;
    }
    await mkdir(dirname(file.path), { recursive: true });
    await writeFile(file.path, bytes);
  }
  console.log(`${file.key}: ${bytes.length} bytes, ${pins[file.key]}`);
}
if (mode === '--record') {
  // Other versions' folders are stale once the pin moves.
  await writeFile(
    configPath,
    `${JSON.stringify({ ...config, sha256: pins }, null, 2)}\n`,
  );
  if (existsSync(outputRoot)) {
    for (const entry of await readdir(outputRoot)) {
      if (entry !== `v${config.duckdbVersion}`) {
        await rm(join(outputRoot, entry), { recursive: true });
      }
    }
  }
}
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
