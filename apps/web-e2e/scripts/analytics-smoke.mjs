import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, firefox, webkit } from '@playwright/test';

const repoRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const webRequire = createRequire(resolve(repoRoot, 'apps/web/package.json'));
const parquetWasm = await import(
  pathToFileURL(webRequire.resolve('parquet-wasm/node'))
);
const arrow = await import(
  pathToFileURL(webRequire.resolve('apache-arrow'))
);
const parquetSource = arrow.tableFromArrays({
  name: ['epsilon', 'zeta'],
  amount: new Int32Array([3, 11]),
  details: arrow.vectorFromArray(
    [{ count: 9007199254740993n }, { count: 9007199254740994n }],
    new arrow.Struct([new arrow.Field('count', new arrow.Int64(), true)]),
  ),
});
const parquetBytes = parquetWasm.writeParquet(
  parquetWasm.Table.fromIPCStream(arrow.tableToIPC(parquetSource, 'stream')),
);
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
 return { csv, sorted, filtered, json, jsonRows, parquet, parquetRows, cancelled };
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
      ? { executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] }
      : {}),
  });
  const page = await browser.newPage();
  const outsideRequests = [];
  page.on('request', (request) => {
    if (!request.url().startsWith(baseUrl)) outsideRequests.push(request.url());
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
      // Vite can reload once when the lazy Parquet decoder is first optimized
      // in a clean checkout. Run the entire test in the replacement context.
      if (
        attempt === 2 ||
        !/Execution context was destroyed|because of a navigation/.test(
          error.message,
        )
      ) {
        throw error;
      }
      developmentReloads++;
      await page.reload();
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
  assert.equal(result.filtered.totalRows, 1);
  assert.equal(result.filtered.rows[0].name, 'alpha');
  assert.equal(result.json.engineVersion, 'v1.4.3');
  assert.equal(result.jsonRows.rows[0].name, 'gamma');
  assert.equal(result.jsonRows.rows[0].code, '001');
  assert.equal(result.jsonRows.rows[0].empty, '');
  assert.equal(result.jsonRows.rows[0].nil, null);
  assert.equal(String(result.jsonRows.rows[1].nil), '4');
  assert.equal(result.jsonRows.rows[0].mix, '1');
  assert.equal(result.jsonRows.rows[1].mix, '"word"');
  assert.equal(result.jsonRows.rows[1].nested, '{"y":2}');
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
