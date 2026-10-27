import type { Page } from '@playwright/test';
import { expect, test as base, asRole } from './fixtures';
import { bigCsv, parquetFile } from './analytics-files';

// The Data Explorer (/analytics): a local file read by DuckDB-Wasm in a worker,
// through the page's file upload, on the built app under the production
// Content-Security-Policy (vite preview sends Caddy's headers:
// apps/web/preview-headers.ts). Runs in Chromium with the other specs and, on
// request, in Firefox and WebKit (playwright.config.ts, E2E_EXTRA_BROWSERS).
// The first file starts the engine (the WebAssembly is compiled in a new
// worker, again after Cancel): more than expect's 5 seconds on a cold runner.
const ENGINE = { timeout: 30_000 };
const FLAG = '/v1/settings/analytics.browser.enabled';

const test = base.extend<{ outsideRequests: string[] }>({
  // The explorer's promise (its privacy line): no file, and no request at all,
  // leaves the page's origin. By origin, not by scheme: WebKit also reports
  // reads of the page's own blob: URLs (the files the test hands over), whose
  // origin is the page's; a data: URL is no request on the network.
  outsideRequests: [
    async ({ context, baseURL }, use) => {
      const origin = new URL(baseURL ?? 'http://localhost').origin;
      const outside: string[] = [];
      context.on('request', (request) => {
        const url = new URL(request.url());
        if (url.protocol !== 'data:' && url.origin !== origin) {
          outside.push(request.url());
        }
      });
      await use(outside);
      expect(outside, 'requests that left the page origin').toEqual([]);
    },
    { auto: true },
  ],
});

test.use(asRole('administrator'));

// The browser analytics flag is off by default (a tenant switch): the
// administrator turns it on for the run and back off after.
test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext(asRole('administrator'));
  const on = await context.request.put(FLAG, {
    data: { scope: 'tenant', value: true },
  });
  expect(on.ok(), await on.text()).toBe(true);
  await context.close();
});

test.afterAll(async ({ browser }) => {
  const context = await browser.newContext(asRole('administrator'));
  await context.request.delete(`${FLAG}?scope=tenant`);
  await context.close();
});

test.beforeEach(async ({ page }) => {
  const response = await page.goto('/analytics');
  // The policy is on: this run is the production one's check, not the dev server's.
  expect(response?.headers()['content-security-policy']).toContain(
    "script-src 'self' 'wasm-unsafe-eval'",
  );
  await expect(
    page.getByRole('heading', { name: 'Browser analytics', level: 1 }),
  ).toBeVisible();
});

const upload = (
  page: Page,
  file: string | { name: string; mimeType: string; buffer: Buffer },
) => page.locator('input[type="file"]').setInputFiles(file);

test('a CSV file: its profile, a grouped aggregate and a histogram', async ({
  page,
}) => {
  await upload(page, {
    name: 'sales.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('region,amount\nnorth,2\nnorth,10\nsouth,5\n'),
  });
  await expect(page.getByText('Rows: 3')).toBeVisible(ENGINE);
  await expect(page.getByText('Columns: 2')).toBeVisible();

  const profile = page.getByRole('table', { name: 'Column profile' });
  const region = profile.getByRole('row', { name: /^region / });
  const amount = profile.getByRole('row', { name: /^amount / });
  await expect(region).toContainText('VARCHAR');
  await expect(amount).toContainText('2 – 10');

  // Group by the first text column, summing the first number.
  await page.getByRole('tab', { name: 'Group by' }).click();
  const grouped = page.getByRole('figure', { name: 'Chart of the groups' });
  await expect(grouped.locator('[data-slot="chart"]')).toBeVisible();
  await expect(grouped.locator('.recharts-bar-rectangle')).toHaveCount(2);
  const results = page.getByRole('table', { name: 'Results' });
  await expect(results.getByRole('row', { name: 'north 12' })).toBeVisible();
  await expect(results.getByRole('row', { name: 'south 5' })).toBeVisible();

  await page.getByRole('tab', { name: 'Histogram' }).click();
  const histogram = page.getByRole('figure', { name: 'Histogram' });
  await expect(histogram.locator('[data-slot="chart"]')).toBeVisible();
  await expect(
    histogram.locator('.recharts-bar-rectangle').first(),
  ).toBeVisible();
});

test('a Parquet file is read and queried', async ({ page }) => {
  await upload(page, {
    name: 'tiny.parquet',
    mimeType: 'application/octet-stream',
    buffer: await parquetFile(),
  });
  await expect(page.getByText('Rows: 2')).toBeVisible(ENGINE);
  await expect(page.getByText('Columns: 2')).toBeVisible();
  const profile = page.getByRole('table', { name: 'Column profile' });
  await expect(profile.getByRole('row', { name: /^amount / })).toContainText(
    '3 – 11',
  );
  const results = page.getByRole('table', { name: 'Results' });
  await expect(results.getByRole('row', { name: 'zeta 11' })).toBeVisible();

  await page.getByRole('tab', { name: 'Group by' }).click();
  await expect(
    page
      .getByRole('figure', { name: 'Chart of the groups' })
      .locator('[data-slot="chart"]'),
  ).toBeVisible();
});

test('a JSON file: exact null counts and mixed values kept as text', async ({
  page,
}) => {
  const rows = [
    { name: 'gamma', code: '001', nil: null, mix: 1, amount: 7 },
    { name: 'delta', code: '002', nil: 4, mix: 'word', amount: 8 },
  ];
  await upload(page, {
    name: 'tiny.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(rows)),
  });
  await expect(page.getByText('Rows: 2')).toBeVisible(ENGINE);
  const profile = page.getByRole('table', { name: 'Column profile' });
  const nulls = (column: string) =>
    profile
      .getByRole('row', { name: new RegExp(`^${column} `) })
      .getByRole('cell')
      .nth(2);
  await expect(nulls('nil')).toHaveText('1');
  await expect(nulls('name')).toHaveText('0');
  // A column of numbers and a string is text; each value keeps its JSON form.
  const results = page.getByRole('table', { name: 'Results' });
  await expect(
    results.getByRole('cell', { name: '"word"', exact: true }),
  ).toBeVisible();
  // A leading-zero code stays text.
  await expect(
    results.getByRole('cell', { name: '001', exact: true }),
  ).toBeVisible();
});

test('Cancel stops the engine, and a file can be chosen again', async ({
  page,
}) => {
  // Cancel is there while the file is read; a big file keeps it busy.
  await upload(page, {
    name: 'big.csv',
    mimeType: 'text/csv',
    buffer: bigCsv(1_500_000),
  });
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByText(/^Cancelled\./)).toBeVisible();
  await expect(
    page.getByRole('table', { name: 'Column profile' }),
  ).toBeHidden();

  // The worker was ended, not left running: a new file opens a new engine.
  await upload(page, {
    name: 'small.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('name,amount\nalpha,1\n'),
  });
  await expect(page.getByText('Rows: 1')).toBeVisible(ENGINE);
});
