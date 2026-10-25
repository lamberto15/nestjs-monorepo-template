#!/usr/bin/env node
/** Isolated DuckDB and data-transfer reader probe; see docs/analytics.md. */
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import {
  closeSync,
  createReadStream,
  createWriteStream,
  fstatSync,
  openSync,
} from 'node:fs';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const worker = process.argv[2] === '--worker';
const jsonOnly = process.env.BENCH_JSON_ONLY === '1';
const apiReaderUrl = pathToFileURL(
  process.env.TRANSFER_READER_ENTRY
    ? resolve(process.env.TRANSFER_READER_ENTRY)
    : fileURLToPath(
        new URL(
          '../../apps/api/dist/platform/data-transfer/formats.js',
          import.meta.url,
        ),
      ),
);
const require = createRequire(import.meta.url);
const ExcelJS = require('../../apps/api/node_modules/exceljs');

const WORKER_MODES = new Map([
  ['baseline-json', 'json'],
  ['baseline-xlsx', 'xlsx'],
  ['spooled-json', 'json'],
  ['spooled-xlsx', 'xlsx'],
  ['revised-json', 'json'],
  ['revised-xlsx', 'xlsx'],
  ['revised-two-pass-json', 'json'],
  ['revised-two-pass-xlsx', 'xlsx'],
  ['duckdb-json-transform', 'json'],
]);

function benchmarkError(message = 'Invalid benchmark worker request.') {
  return new Error(message);
}

function maxRssMiB() {
  // Node reports ru_maxrss in bytes on macOS, KiB on Linux and other Unix.
  const raw = process.resourceUsage().maxRSS;
  return +(raw / (process.platform === 'darwin' ? 1048576 : 1024)).toFixed(1);
}

if (worker) {
  let directory;
  let ownsInput = false;
  try {
    const modeEntry = [...WORKER_MODES.entries()].find(
      ([knownMode]) => knownMode === process.argv[3],
    );
    if (process.argv.length !== 4 || !modeEntry) throw benchmarkError();
    const [mode, format] = modeEntry;
    if (!fstatSync(3).isFile()) throw benchmarkError();
    ownsInput = true;
    directory = await mkdtemp(join(tmpdir(), 'duckdb-feasibility-worker-'));
    const file = join(directory, `source.${format}`);
    await pipeline(
      createReadStream(null, { fd: 3, autoClose: false }),
      createWriteStream(file, { flags: 'wx', mode: 0o600 }),
    );
    const inputBytes = (await stat(file)).size;
    const cpu = process.cpuUsage();
    const started = performance.now();
    let rows = 0;
    let spoolBytes;
    let parquetBytes;
    let temporaryDatabaseBytes;
    if (mode === 'baseline-json') {
      rows = JSON.parse(await readFile(file, 'utf8')).length;
    } else if (mode === 'baseline-xlsx') {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(await readFile(file));
      rows = Math.max(0, (workbook.worksheets[0]?.rowCount ?? 1) - 1);
    } else if (mode === 'spooled-json' || mode === 'spooled-xlsx') {
      const { spoolImportRecords, readImportSpool } = await import(
        process.env.TRANSFER_SPOOL_ENTRY
      );
      const spoolPath = join(directory, 'normalized.ndjson');
      const inspected = await spoolImportRecords(format, file, spoolPath, {
        dateColumns: new Set(),
        maxRows: 2_000_000,
        scratchDirectory: join(directory, 'scratch'),
      });
      for await (const _ of readImportSpool(spoolPath)) rows++;
      if (rows !== inspected.rowCount)
        throw new Error(
          `Spool replay returned ${rows} rows; expected ${inspected.rowCount}.`,
        );
      spoolBytes = (await stat(spoolPath)).size;
      if (process.env.BENCH_KEEP_FILES !== '1')
        await rm(spoolPath, { force: true });
    } else if (
      mode === 'revised-json' ||
      mode === 'revised-xlsx' ||
      mode === 'revised-two-pass-json' ||
      mode === 'revised-two-pass-xlsx'
    ) {
      const { inspectRecords, readRecords } = await import(apiReaderUrl.href);
      if (mode.startsWith('revised-two-pass')) {
        await inspectRecords(format, createReadStream(file));
      }
      for await (const _ of readRecords(format, createReadStream(file))) rows++;
    } else if (mode === 'duckdb-json-transform') {
      const { DuckDBInstance } = await import(process.env.DUCKDB_NODE_API);
      const dbFile = join(directory, 'benchmark.duckdb');
      const parquet = join(directory, 'result.parquet');
      const instance = await DuckDBInstance.create(dbFile, { threads: '2' });
      const db = await instance.connect();
      try {
        const escaped = file.replaceAll("'", "''");
        const escapedParquet = parquet.replaceAll("'", "''");
        await db.run(
          `CREATE TABLE source AS SELECT * FROM read_json_auto('${escaped}')`,
        );
        await db.run(
          'CREATE TABLE grouped AS SELECT group_id, count(*) AS n, sum(amount) AS total FROM source GROUP BY group_id',
        );
        await db.run(
          'CREATE TABLE joined AS SELECT s.id, s.category, g.n, g.total FROM source s JOIN grouped g USING (group_id)',
        );
        await db.run(
          `COPY (SELECT * FROM joined) TO '${escapedParquet}' (FORMAT PARQUET)`,
        );
        const result = await db.run('SELECT count(*) AS n FROM joined');
        rows = Number((await result.getRows())[0][0]);
      } finally {
        db.closeSync();
      }
      parquetBytes = (await stat(parquet)).size;
      temporaryDatabaseBytes = (await stat(dbFile)).size;
    }
    const used = process.cpuUsage(cpu);
    const durationMs = +(performance.now() - started).toFixed(1);
    const files = await readdir(directory, {
      recursive: true,
      withFileTypes: true,
    });
    let workspaceBytes = 0;
    for (const entry of files)
      if (entry.isFile())
        workspaceBytes += (await stat(join(entry.parentPath, entry.name))).size;
    if (process.env.BENCH_KEEP_FILES !== '1') workspaceBytes += spoolBytes ?? 0;
    console.log(
      JSON.stringify({
        mode,
        inputMiB: +(inputBytes / 1048576).toFixed(2),
        rows,
        durationMs,
        throughputMiBps: +(inputBytes / 1048576 / (durationMs / 1000)).toFixed(
          2,
        ),
        cpuMs: +((used.user + used.system) / 1000).toFixed(1),
        maxRssMiB: maxRssMiB(),
        workspaceBytes,
        ...(spoolBytes === undefined ? {} : { spoolBytes }),
        ...(parquetBytes === undefined ? {} : { parquetBytes }),
        ...(temporaryDatabaseBytes === undefined
          ? {}
          : { temporaryDatabaseBytes }),
      }),
    );
  } finally {
    // Close once: freeing this number earlier could let another resource
    // reuse it and then be accidentally closed during cleanup.
    if (ownsInput) closeSync(3);
    if (directory && process.env.BENCH_KEEP_FILES !== '1')
      await rm(directory, { recursive: true, force: true });
  }
} else {
  const sizes = (process.env.BENCH_SIZES_MB ?? '5,25,50')
    .split(',')
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0);
  const tmp = await mkdtemp(join(tmpdir(), 'duckdb-feasibility-'));
  const results = [];
  let peakTemporaryDiskBytes = 0;
  let retainedWorkerWorkspaceBytes = 0;
  const initialInput = {
    id: 1,
    group_id: 1,
    category: 'category-1',
    amount: 7919,
    label: 'synthetic row 1 with representative text payload',
  };
  const rowBytes = JSON.stringify(initialInput).length + 1;
  async function fixtureDiskBytes() {
    const entries = await readdir(tmp, {
      recursive: true,
      withFileTypes: true,
    });
    let bytes = 0;
    for (const entry of entries)
      if (entry.isFile())
        bytes += (await stat(join(entry.parentPath, entry.name))).size;
    return bytes;
  }
  async function run(mode, file) {
    if (!WORKER_MODES.has(mode)) throw benchmarkError();
    const inputFd = openSync(file, 'r');
    let child;
    try {
      child = spawnSync(
        process.execPath,
        [fileURLToPath(import.meta.url), '--worker', mode],
        {
          encoding: 'utf8',
          env: process.env,
          maxBuffer: 1024 * 1024,
          stdio: ['ignore', 'pipe', 'pipe', inputFd],
        },
      );
    } finally {
      closeSync(inputFd);
    }
    if (child.status !== 0)
      throw new Error(
        `${mode} failed (worker exit ${child.status ?? 'unavailable'}).`,
      );
    const result = JSON.parse(child.stdout.trim().split('\n').at(-1));
    peakTemporaryDiskBytes = Math.max(
      peakTemporaryDiskBytes,
      (await fixtureDiskBytes()) + result.workspaceBytes,
    );
    if (process.env.BENCH_KEEP_FILES === '1')
      retainedWorkerWorkspaceBytes += result.workspaceBytes;
    return result;
  }
  try {
    if (!jsonOnly && !process.env.DUCKDB_NODE_API)
      throw new Error(
        'Set DUCKDB_NODE_API to the entry point of an isolated @duckdb/node-api install.',
      );
    for (const targetMiB of sizes) {
      const rowCount = Math.ceil((targetMiB * 1048576) / rowBytes);
      const jsonPath = join(tmp, `rows-${targetMiB}.json`);
      const xlsxPath = join(tmp, `rows-${targetMiB}.xlsx`);
      const output = createWriteStream(jsonPath, { flags: 'wx' });
      const workbook = jsonOnly
        ? undefined
        : new ExcelJS.stream.xlsx.WorkbookWriter({
            filename: xlsxPath,
            useSharedStrings: false,
            useStyles: false,
          });
      const sheet = workbook?.addWorksheet('data');
      sheet?.addRow(['id', 'group_id', 'category', 'amount', 'label']).commit();
      output.write('[');
      for (let i = 0; i < rowCount; i++) {
        const row = {
          id: i + 1,
          group_id: i % 1000,
          category: `category-${i % 16}`,
          amount: (i * 7919) % 100000,
          label: `synthetic row ${i + 1} with representative text payload`,
        };
        if (i > 0 && !output.write(',')) await once(output, 'drain');
        if (!output.write(JSON.stringify(row))) await once(output, 'drain');
        sheet
          ?.addRow([row.id, row.group_id, row.category, row.amount, row.label])
          .commit();
      }
      output.end(']');
      await Promise.all([once(output, 'finish'), workbook?.commit()]);
      const jsonBytes = (await stat(jsonPath)).size;
      // Each parser runs in a clean child process. The RSS value is that
      // child's OS peak, avoiding heap retention from earlier parser cases.
      results.push(await run('baseline-json', jsonPath));
      results.push(await run('revised-json', jsonPath));
      if (!jsonOnly) {
        results.push(await run('baseline-xlsx', xlsxPath));
        results.push(await run('revised-xlsx', xlsxPath));
      }
      if (process.env.BENCH_TWO_PASS === '1') {
        results.push(await run('revised-two-pass-json', jsonPath));
        if (!jsonOnly)
          results.push(await run('revised-two-pass-xlsx', xlsxPath));
      }
      if (process.env.BENCH_SPOOL === '1') {
        if (!process.env.TRANSFER_SPOOL_ENTRY)
          throw new Error(
            'Set TRANSFER_SPOOL_ENTRY to the bundled import-spool module.',
          );
        results.push(await run('spooled-json', jsonPath));
      }
      if (!jsonOnly) {
        results.push(await run('duckdb-json-transform', jsonPath));
        const duckdbResult = results.findLast(
          (result) =>
            result.mode === 'duckdb-json-transform' &&
            result.inputMiB === +(jsonBytes / 1048576).toFixed(2),
        );
        duckdbResult.sourceFileBytes = jsonBytes;
        duckdbResult.xlsxFileBytes = (await stat(xlsxPath)).size;
      }
      const perSize =
        (jsonOnly ? 2 : 5) +
        (process.env.BENCH_TWO_PASS === '1' ? (jsonOnly ? 1 : 2) : 0) +
        (process.env.BENCH_SPOOL === '1' ? 1 : 0);
      console.log(
        JSON.stringify({
          completedSizeMiB: targetMiB,
          results: results.slice(-perSize),
        }),
      );
    }
    const generatedInputBytes = await fixtureDiskBytes();
    const tempDiskBytes =
      process.env.BENCH_KEEP_FILES === '1'
        ? generatedInputBytes + retainedWorkerWorkspaceBytes
        : peakTemporaryDiskBytes;
    console.log(
      JSON.stringify(
        {
          node: process.version,
          duckdbApi: jsonOnly ? undefined : '1.5.6-r.2',
          tempDiskMiB: +(tempDiskBytes / 1048576).toFixed(2),
          results,
        },
        null,
        2,
      ),
    );
  } finally {
    if (process.env.BENCH_KEEP_FILES !== '1')
      await rm(tmp, { recursive: true, force: true });
  }
}
