import ExcelJS from 'exceljs';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import type { TransferFormat } from './data-transfer.types.js';
import { readRecords } from './formats.js';

/**
 * The memory budget of an import (#618): 100,000-row CSV, JSON and XLSX
 * files, read through readRecords as the worker reads an upload, must stay
 * within a few MB of retained memory; a file read whole (the JSON and XLSX
 * paths before #618) holds every row at once and fails it. A file of its
 * own, so the measurement has its own process (Vitest runs one file per
 * worker), and the rows are generated here.
 *
 * What is measured: the live heap plus Node's buffers (heapUsed +
 * arrayBuffers: a whole file read into a Buffer counts there), after a
 * forced collection every 10,000 rows, minus the same before the read. So
 * garbage, which the collector reclaims on its own schedule, doesn't count;
 * only what the reader keeps does, which makes the budget stable on any
 * runner. V8's gc() is exposed at run time (no --expose-gc in the config).
 */
setFlagsFromString('--expose-gc');
const gc = (globalThis.gc ?? runInNewContext('gc')) as () => void;

const ROWS = 100_000;
/**
 * Retained growth allowed while reading 100k rows (~30 MB of JSON): streamed,
 * each format keeps under 1 MB; the JSON read whole keeps about 31 MB.
 */
const BUDGET_MB = 16;
const SAMPLE_EVERY = 10_000;

const body = (i: number) =>
  `Row ${i}: ${'a note body long enough to weigh like a real one, '.repeat(4)}end`;
const recordOf = (i: number) => ({
  title: `Note ${i}`,
  body: body(i),
  status: i % 2 ? 'draft' : 'published',
  amount: String(i % 1000),
});

const megabytes = (bytes: number) => Math.round((bytes / 2 ** 20) * 10) / 10;
const retained = () => {
  gc();
  const { heapUsed, arrayBuffers } = process.memoryUsage();
  return heapUsed + arrayBuffers;
};

async function measure(
  rows: AsyncIterable<{ row: number; record: Record<string, unknown> }>,
) {
  const base = retained();
  const rssBase = process.memoryUsage().rss;
  let growth = 0;
  let rss = 0;
  let count = 0;
  let first: Record<string, unknown> | undefined;
  let last: Record<string, unknown> | undefined;
  for await (const { row, record } of rows) {
    count = row;
    first ??= record;
    last = record;
    if (row % SAMPLE_EVERY === 0) {
      growth = Math.max(growth, retained() - base);
      rss = Math.max(rss, process.memoryUsage().rss - rssBase);
    }
  }
  return {
    count,
    first,
    last,
    growthMb: megabytes(growth),
    rssMb: megabytes(rss),
  };
}

describe('import memory budget (#618)', () => {
  let dir: string;
  const file = (format: TransferFormat) => join(dir, `rows.${format}`);

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'formats-memory-'));
    const lines = function* () {
      yield 'title,body,status,amount\n';
      for (let i = 1; i <= ROWS; i++) {
        const { title, body, status, amount } = recordOf(i);
        yield `${title},${body.replaceAll(',', ';')},${status},${amount}\n`;
      }
    };
    await pipeline(Readable.from(lines()), createWriteStream(file('csv')));
    const elements = function* () {
      yield '[';
      for (let i = 1; i <= ROWS; i++) {
        yield `${i > 1 ? ',' : ''}${JSON.stringify(recordOf(i))}\n`;
      }
      yield ']';
    };
    await pipeline(Readable.from(elements()), createWriteStream(file('json')));
    // exceljs's streaming writer: inline strings, rows flushed as written.
    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
      filename: file('xlsx'),
      useSharedStrings: false,
      useStyles: false,
    });
    const sheet = workbook.addWorksheet('Notes');
    sheet.addRow(['title', 'body', 'status', 'amount']).commit();
    for (let i = 1; i <= ROWS; i++) {
      sheet.addRow(Object.values(recordOf(i))).commit();
    }
    sheet.commit();
    await workbook.commit();
  }, 60_000);

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it.each(['csv', 'json', 'xlsx'] as const)(
    'reads 100k %s rows within the budget, every row, in order',
    async (format) => {
      const result = await measure(
        readRecords(format, createReadStream(file(format))),
      );
      console.info(
        `${format}: ${result.growthMb} MB retained, ${result.rssMb} MB RSS growth, budget ${BUDGET_MB} MB`,
      );
      // CSV and spreadsheet cells come as text; the body's commas were CSV's separators.
      const expected = (i: number) =>
        format === 'csv'
          ? { ...recordOf(i), body: body(i).replaceAll(',', ';') }
          : recordOf(i);
      expect(result.count).toBe(ROWS);
      expect(result.first).toEqual(expected(1));
      expect(result.last).toEqual(expected(ROWS));
      expect(result.growthMb).toBeLessThan(BUDGET_MB);
    },
    30_000,
  );

  it('is a budget a whole-file read fails', async () => {
    // The JSON path before #618: the file in one buffer, then JSON.parse.
    async function* whole() {
      const elements = JSON.parse(
        await readFile(file('json'), 'utf8'),
      ) as Record<string, unknown>[];
      for (const [i, record] of elements.entries()) {
        yield { row: i + 1, record };
      }
    }
    const result = await measure(whole());
    console.info(`json read whole: ${result.growthMb} MB retained`);
    expect(result.count).toBe(ROWS);
    expect(result.growthMb).toBeGreaterThan(BUDGET_MB);
  }, 30_000);
});
