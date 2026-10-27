import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, firefox, webkit } from '@playwright/test';

const repoRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const webRequire = createRequire(resolve(repoRoot, 'apps/web/package.json'));
// DuckDB-Wasm's own Node build writes the Parquet fixture (nothing else decodes it).
// The package's main entry sits in its dist folder, next to the wasm files.
const duckdbDist = dirname(webRequire.resolve('@duckdb/duckdb-wasm'));
const duckdbNode = webRequire(`${duckdbDist}/duckdb-node-blocking.cjs`);
const fixtureDb = await duckdbNode.createDuckDB(
  {
    mvp: { mainModule: `${duckdbDist}/duckdb-mvp.wasm`, mainWorker: '' },
    eh: { mainModule: `${duckdbDist}/duckdb-eh.wasm`, mainWorker: '' },
  },
  new duckdbNode.VoidLogger(),
  duckdbNode.NODE_RUNTIME,
);
await fixtureDb.instantiate(() => undefined);
fixtureDb.open({});
const fixtureConn = fixtureDb.connect();
const parquetDir = mkdtempSync(join(tmpdir(), 'analytics-smoke-'));
const parquetPath = join(parquetDir, 'smoke.parquet');
fixtureConn.query(
  `COPY (SELECT * FROM (VALUES ('epsilon', 3::INTEGER, {'count': 9007199254740993::BIGINT}), ('zeta', 11::INTEGER, {'count': 9007199254740994::BIGINT})) t(name, amount, details)) TO '${parquetPath}' (FORMAT parquet)`,
);
const parquetBytes = readFileSync(parquetPath);
rmSync(parquetDir, { recursive: true });
fixtureConn.close();
const harnessPath = resolve(repoRoot, 'apps/web/analytics-smoke.html');
const baseUrl = process.env.ANALYTICS_SMOKE_URL ?? 'http://127.0.0.1:5178';
const browserName = process.env.ANALYTICS_BROWSER ?? 'chromium';
const browserType = { chromium, firefox, webkit }[browserName];
if (!browserType) throw new Error(`Unsupported browser: ${browserName}`);
const html = `<!doctype html><script type="module">
import {loadLocalFile,queryDataset,disposeDataset,terminateAnalyticsEngine} from '/src/features/analytics/engine.ts';
window.runAnalyticsSmoke = async () => {
 const csv = await loadLocalFile(new File(['name,amount\\nalpha,2\\nbeta,10\\n'], 'tiny.csv'));
 const sorted = await queryDataset(csv, { sort: { column: 'amount', direction: 'desc' }, limit: 1 });
 const grouped = await queryDataset(csv, { groupBy: 'amount', aggregate: { column: 'amount', fn: 'sum' }, sort: { column: 'amount', direction: 'asc' } });
 const filtered = await queryDataset(csv, { filters: [{ column: 'name', operator: 'contains', value: 'alp' }] });
 const json = await loadLocalFile(new File(['[{"name":"gamma","code":"001","empty":"","nil":null,"mix":1,"nested":{"x":1},"amount":7},{"name":"delta","code":"002","empty":"x","nil":4,"mix":"word","nested":{"y":2},"amount":8}]'], 'tiny.json'));
 const jsonRows = await queryDataset(json);
 const parquetBytes = Uint8Array.from(${JSON.stringify([...parquetBytes])});
 const parquet = await loadLocalFile(new File([parquetBytes], 'tiny.parquet'));
 const parquetRows = await queryDataset(parquet, { sort: { column: 'amount', direction: 'desc' } });
 const pending = loadLocalFile(new File(['x\\n'.repeat(1000)], 'cancel.csv'));
 terminateAnalyticsEngine();
 let cancelled = false;
 try { await pending; } catch (error) { cancelled = error.message.includes('session was closed'); }
 return { csv, sorted, grouped, filtered, json, jsonRows, parquet, parquetRows, cancelled };
};
</script>`;

if (existsSync(harnessPath))
  throw new Error(`Refusing to overwrite ${harnessPath}`);
writeFileSync(harnessPath, html);
let browser;
try {
  const deadline = Date.now() + 60_000;
  while (true) {
    try {
      const response = await fetch(baseUrl);
      if (response.ok) break;
    } catch {
      // CI starts Vite just before this script; wait for its listener.
    }
    if (Date.now() >= deadline) throw new Error(`Server not ready: ${baseUrl}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  browser = await browserType.launch({
    headless: true,
    ...(browserName === 'chromium'
      ? {
          executablePath: process.env.CHROMIUM_PATH,
          // As playwright.config.ts: CI's own Google Chrome.
          channel: process.env.E2E_BROWSER_CHANNEL || undefined,
          args: ['--no-sandbox'],
        }
      : {}),
  });
  const page = await browser.newPage();
  const outsideRequests = [];
  // By origin: WebKit also reports reads of the page's own blob: URLs (the test's
  // File objects), whose origin is the page's, as requests.
  const pageOrigin = new URL(baseUrl).origin;
  page.on('request', (request) => {
    if (new URL(request.url()).origin !== pageOrigin)
      outsideRequests.push(request.url());
  });
  // A browser reports a failed module import without naming the module: print
  // what the page saw, so a failure in CI says which file and why.
  const diagnostics = [];
  page.on('pageerror', (error) =>
    diagnostics.push(`pageerror: ${error.message}`),
  );
  page.on('console', (message) => {
    if (message.type() === 'error')
      diagnostics.push(`console: ${message.text()}`);
  });
  page.on('requestfailed', (request) =>
    diagnostics.push(
      `requestfailed: ${request.url()} ${request.failure()?.errorText ?? ''}`,
    ),
  );
  page.on('response', (response) => {
    if (response.status() >= 400)
      diagnostics.push(`response ${response.status()}: ${response.url()}`);
  });
  await page.goto(new URL('/analytics-smoke.html', baseUrl).href);
  let result;
  let developmentReloads = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await page.waitForFunction(() => window.runAnalyticsSmoke);
      result = await page.evaluate(() => window.runAnalyticsSmoke());
      break;
    } catch (error) {
      // Vite reloads the page once it sees the harness file written above (and
      // when it first optimizes the lazy engine in a clean checkout). The reload
      // can land mid-import, which each browser reports in its own words. Wait for the
      // reloaded harness and run the whole test there; a real error fails 3 times.
      if (diagnostics.length > 0)
        console.error(
          `Attempt ${attempt + 1}:\n${diagnostics.splice(0).join('\n')}`,
        );
      if (
        attempt === 2 ||
        !/Execution context was destroyed|because of a navigation|Importing a module script failed|error loading dynamically imported module|Failed to fetch dynamically imported module/.test(
          error.message,
        )
      ) {
        throw error;
      }
      developmentReloads++;
      // Vite's reload is already navigating: wait for it rather than starting
      // another navigation (page.reload() or goto() would interrupt it).
      await page.waitForLoadState('load');
    }
  }
  assert.equal(result.csv.engineVersion, 'v1.4.3');
  assert.equal(result.csv.rowCount, 2);
  assert.equal(
    result.csv.columns.find((column) => column.name === 'amount')?.min,
    '2',
  );
  assert.equal(
    result.csv.columns.find((column) => column.name === 'amount')?.max,
    '10',
  );
  assert.equal(result.sorted.rows[0].name, 'beta');
  // Integer group keys and SUM results reach the page as plain numbers (charts).
  assert.deepEqual(result.grouped.rows, [
    { amount: 2, value: 2 },
    { amount: 10, value: 10 },
  ]);
  // Exact null counts (the JSON file has one null in "nil").
  assert.equal(
    result.json.columns.find((column) => column.name === 'nil')?.nullCount,
    1,
  );
  assert.equal(
    result.json.columns.find((column) => column.name === 'name')?.nullCount,
    0,
  );
  assert.equal(result.filtered.totalRows, 1);
  assert.equal(result.filtered.rows[0].name, 'alpha');
  assert.equal(result.json.engineVersion, 'v1.4.3');
  assert.equal(result.jsonRows.rows[0].name, 'gamma');
  assert.equal(result.jsonRows.rows[0].code, '001');
  assert.equal(result.jsonRows.rows[0].empty, '');
  assert.equal(result.jsonRows.rows[0].nil, null);
  assert.equal(result.jsonRows.rows[1].nil, 4);
  assert.equal(result.jsonRows.rows[0].mix, '1');
  assert.equal(result.jsonRows.rows[1].mix, '"word"');
  assert.deepEqual(result.jsonRows.rows[1].nested, { x: null, y: 2n });
  assert.equal(result.parquet.engineVersion, 'v1.4.3');
  assert.equal(result.parquet.rowCount, 2);
  assert.equal(
    result.parquet.columns.find((column) => column.name === 'amount')?.min,
    '3',
  );
  assert.equal(
    result.parquet.columns.find((column) => column.name === 'amount')?.max,
    '11',
  );
  assert.equal(result.parquetRows.rows[0].name, 'zeta');
  assert.deepEqual(result.parquetRows.rows[0].details, {
    count: 9007199254740994n,
  });
  assert.equal(result.cancelled, true);
  assert.deepEqual(outsideRequests, []);
  console.log(
    JSON.stringify(
      {
        engineVersion: result.csv.engineVersion,
        browser: browserName,
        developmentReloads,
        csvRows: result.csv.rowCount,
        sortedSample: result.sorted.rows,
        jsonSample: result.jsonRows.rows,
        parquetRows: result.parquet.rowCount,
        parquetSample: result.parquetRows.rows,
        cancellation: result.cancelled,
        externalRequests: outsideRequests,
      },
      (_, value) => (typeof value === 'bigint' ? value.toString() : value),
    ),
  );
} finally {
  await browser?.close();
  unlinkSync(harnessPath);
}
