import type { EventEmitter } from 'node:events';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline as pipelineAsync } from 'node:stream/promises';
import { PassThrough, pipeline, type Readable } from 'node:stream';
import { parse } from 'csv-parse';
import { stringify } from 'csv-stringify';
import ExcelJS from 'exceljs';
import { streamArray } from 'stream-json/streamers/stream-array.js';
import type {
  ImportColumn,
  TransferColumn,
  TransferFormat,
} from './data-transfer.types.js';
import { exampleOf } from './import-columns.js';
import {
  headerColumn as columnOf,
  type ImportMapping,
  renameHeaders,
} from './import-mapping.js';

/**
 * The file formats, streamed both ways: a 100 MB export or import never sits
 * in memory. The libraries (csv-stringify / csv-parse, exceljs) are used only
 * here, so one can be replaced in one place.
 */

export const CONTENT_TYPES: Record<TransferFormat, string> = {
  csv: 'text/csv; charset=utf-8',
  json: 'application/json',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/**
 * Text a spreadsheet app would run as a formula (CSV/formula injection):
 * cells starting with =, +, -, @, a tab or a carriage return.
 */
const FORMULA_START = /^[=+\-@\t\r]/;
/** Such text as an export writes it (`'=1+1`, `'+63 912`): the quote is not part of the value. */
const QUOTED_FORMULA = /^'[=+\-@\t\r]/;

/** Excel's number formats of a date-time and a date cell. */
const DATETIME_FORMAT = 'yyyy-mm-dd hh:mm:ss';
const DAY_FORMAT = 'yyyy-mm-dd';

/** A calendar day as a `date` column holds it. */
const isDay = (value: unknown): value is string =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);

const zoneFormats = new Map<string, Intl.DateTimeFormat>();

/** The wall-clock time of a moment in `timeZone`, and the zone's offset then. */
function wallClock(date: Date, timeZone: string) {
  let format = zoneFormats.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      fractionalSecondDigits: 3,
      hourCycle: 'h23',
      timeZoneName: 'longOffset',
    });
    zoneFormats.set(timeZone, format);
  }
  const part = Object.fromEntries(
    format.formatToParts(date).map(({ type, value }) => [type, value]),
  ) as Record<Intl.DateTimeFormatPartTypes, string>;
  return {
    date: `${part.year}-${part.month}-${part.day}`,
    time: `${part.hour}:${part.minute}:${part.second}`,
    ms: part.fractionalSecond,
    // longOffset is "GMT+04:00", or "GMT" at zero.
    offset: part.timeZoneName.replace('GMT', '') || '+00:00',
  };
}

/**
 * A moment in ISO 8601 as the wall-clock time of `timeZone`, with its offset
 * (`2026-10-15T18:30:00.000+04:00` in Asia/Dubai): for JSON, read by
 * programs. Intl, not a date library: Node has no Temporal yet.
 */
export function isoInZone(date: Date, timeZone: string) {
  const { date: day, time, ms, offset } = wallClock(date, timeZone);
  return `${day}T${time}.${ms}${offset}`;
}

/**
 * A moment as people read it in `timeZone`, `2026-10-15 18:30:00`: Excel,
 * LibreOffice and Sheets take it for a date and time (an offset would make
 * it text). The zone goes in the column's header.
 */
export function localDateTime(date: Date, timeZone: string) {
  const { date: day, time } = wallClock(date, timeZone);
  return `${day} ${time}`;
}

/** The milliseconds `timeZone` is ahead of UTC at `time`. */
function offsetAt(time: number, timeZone: string) {
  const { date, time: clock, ms } = wallClock(new Date(time), timeZone);
  return Date.parse(`${date}T${clock}.${ms}Z`) - time;
}

const WALL_CLOCK =
  /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3})\d*)?)?$/;

/**
 * A wall-clock time of `timeZone` (`2026-10-15 18:30:00`, what a zoned
 * column holds) as the moment, in ISO 8601 UTC; undefined when it isn't
 * one (an explicit offset, a typo: left to the importer's schema).
 */
export function instantOf(text: string, timeZone: string) {
  const match = WALL_CLOCK.exec(text.trim());
  if (!match) return undefined;
  const [, year, month, day, hour, minute, second = '0', ms = '0'] = match;
  const asUtc = Date.UTC(
    +year!,
    +month! - 1,
    +day!,
    +hour!,
    +minute!,
    +second,
    +ms.padEnd(3, '0'),
  );
  const date = new Date(asUtc);
  if (date.getUTCDate() !== +day! || date.getUTCHours() !== +hour!) {
    return undefined; // 2026-02-30, 25:00
  }
  // The zone's offsets a day before and after (one change at most between):
  // the moments that show this wall-clock time. Two (the hour a clock goes
  // back): the earlier. None (the hour it skips): moved forward by the gap,
  // as Temporal does.
  const DAY = 86_400_000;
  const candidates = [
    asUtc - offsetAt(asUtc - DAY, timeZone),
    asUtc - offsetAt(asUtc + DAY, timeZone),
  ];
  const real = candidates.filter(
    (moment) => moment + offsetAt(moment, timeZone) === asUtc,
  );
  const time = real.length ? Math.min(...real) : Math.max(...candidates);
  return new Date(time).toISOString();
}

/** A date-time column's header in CSV and Excel: `createdAt (Asia/Dubai)`. */
const zonedHeader = (name: string, timeZone: string) => `${name} (${timeZone})`;
/**
 * A value as a cell: dates in ISO 8601 in `timeZone`, objects as JSON,
 * nothing as empty. Text that would start a formula gets a leading single
 * quote, so Excel, LibreOffice or Sheets show it as text instead of running it.
 */
const cell = (value: unknown, timeZone: string) => {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return isoInZone(value, timeZone);
  if (typeof value === 'object') return JSON.stringify(value);
  if (typeof value === 'string' && FORMULA_START.test(value)) {
    return `'${value}`;
  }
  return value as string | number | boolean;
};

/**
 * Waits for `stream` to drain. Rejects instead when it, or one of `watched`
 * (the stream it feeds), fails or closes first: a consumer that stopped
 * reading never drains it.
 */
function drained(stream: EventEmitter, watched: EventEmitter[] = []) {
  return new Promise<void>((resolve, reject) => {
    const emitters = [stream, ...watched];
    const cleanup = () => {
      stream.off('drain', onDrain);
      for (const emitter of emitters) {
        emitter.off('error', onError);
        emitter.off('close', onClose);
      }
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onError = (error: unknown) => {
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const onClose = () => {
      cleanup();
      reject(new Error('The file stream closed before it was written.'));
    };
    stream.once('drain', onDrain);
    for (const emitter of emitters) {
      emitter.once('error', onError);
      emitter.once('close', onClose);
    }
  });
}

/** Refuses to write into a stream that was already destroyed. */
function assertOpen(...streams: { destroyed: boolean }[]) {
  if (streams.some((stream) => stream.destroyed)) {
    throw new Error('The file stream was closed.');
  }
}

/**
 * Writes rows into a stream in `format`, times in `timeZone` (an IANA name):
 * in CSV and Excel, date-time columns as local time with the zone in their
 * header, Excel's as date cells; in JSON, ISO 8601 with the offset. Excel
 * gets a `date` column's days as date cells too.
 * `end()` finishes the file, and `destroy(error)` abandons it (the consumer
 * of `output` sees the error, so an upload in progress is aborted rather
 * than left open).
 */
export function createWriter(
  format: TransferFormat,
  columns: readonly TransferColumn[],
  timeZone = 'UTC',
) {
  const output = new PassThrough();
  const datetime = (column: TransferColumn) =>
    format !== 'json' && column.type === 'datetime';
  const headers = columns.map((column) => {
    const name = column.header ?? column.key;
    return datetime(column) ? zonedHeader(name, timeZone) : name;
  });
  const read = (column: TransferColumn, row: Record<string, unknown>) =>
    column.value ? column.value(row) : row[column.key];
  const values = (row: Record<string, unknown>) =>
    columns.map((column) => {
      const value = read(column, row);
      if (format === 'xlsx' && column.type === 'date' && isDay(value)) {
        // A day as an Excel date cell (exceljs turns a Date into a serial
        // from its UTC time).
        return new Date(`${value}T00:00:00Z`);
      }
      if (!datetime(column) || !(value instanceof Date)) {
        return cell(value, timeZone);
      }
      if (format === 'csv') return localDateTime(value, timeZone);
      // exceljs turns a Date into a serial from its UTC time, and an Excel
      // date has no zone: the local wall-clock time, given as UTC.
      const { date, time, ms } = wallClock(value, timeZone);
      return new Date(`${date}T${time}.${ms}Z`);
    });

  if (format === 'csv') {
    const csv = stringify({
      header: true,
      columns: headers,
      bom: true,
      // csv-stringify writes false as an empty cell: an import would read "no value".
      cast: { boolean: (value) => (value ? 'true' : 'false') },
    });
    csv.pipe(output);
    return {
      output,
      write: async (rows: Record<string, unknown>[]) => {
        for (const row of rows) {
          assertOpen(csv, output);
          if (!csv.write(values(row))) {
            await drained(csv, [output]);
          }
        }
      },
      end: () =>
        new Promise<void>((resolve, reject) =>
          csv.end((error?: Error | null) =>
            error ? reject(error) : resolve(),
          ),
        ),
      destroy: (error: Error) => {
        csv.unpipe(output);
        csv.destroy();
        output.destroy(error);
      },
    };
  }

  if (format === 'json') {
    let first = true;
    output.write('[');
    return {
      output,
      write: async (rows: Record<string, unknown>[]) => {
        for (const row of rows) {
          const record = Object.fromEntries(
            columns.map((column) => {
              const value = read(column, row);
              return [
                column.header ?? column.key,
                value instanceof Date
                  ? isoInZone(value, timeZone)
                  : (value ?? null),
              ];
            }),
          );
          assertOpen(output);
          const more = output.write(
            `${first ? '' : ','}\n${JSON.stringify(record)}`,
          );
          first = false;
          if (!more) {
            await drained(output);
          }
        }
      },
      end: async () => {
        output.end('\n]\n');
      },
      destroy: (error: Error) => {
        output.destroy(error);
      },
    };
  }

  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
    stream: output,
    // Styles: a date cell needs its number format to show as a date.
    useStyles: true,
    useSharedStrings: false,
  });
  const sheet = workbook.addWorksheet('Data');
  sheet.addRow(headers).commit();
  // A date cell shows as a date only with a number format: per column.
  const numFmts = columns.map((column) =>
    column.type === 'date' ? DAY_FORMAT : DATETIME_FORMAT,
  );
  return {
    output,
    write: async (rows: Record<string, unknown>[]) => {
      assertOpen(output);
      for (const row of rows) {
        const line = sheet.addRow(values(row));
        line.eachCell((cell, i) => {
          if (cell.value instanceof Date) cell.numFmt = numFmts[i - 1]!;
        });
        line.commit();
      }
    },
    end: async () => {
      sheet.commit();
      await workbook.commit();
    },
    destroy: (error: Error) => {
      output.destroy(error);
    },
  };
}

/** The texts of an Excel template's guide, in the reader's language. */
export interface TemplateGuide {
  sheets: { data: string; columns: string };
  /** The guide's header: column, required, type, format, example, description. */
  headers: string[];
  /** The guide's line for one column, under those headers. */
  line(column: ImportColumn): string[];
  /** Said above the guide: the example row is to be replaced. */
  note: string;
}

/** Rows of an Excel template that get a column's dropdown. */
const TEMPLATE_ROWS = 1_000;

/**
 * An import template: the columns' headers and one example row, as an
 * import reads them (date-times local to `timeZone`, the zone in the
 * header; lists comma-separated). The Excel one adds the guide sheet, a
 * dropdown on every column with choices, and date cells for dates. Small:
 * built whole, in memory.
 */
export async function createTemplate(
  format: TransferFormat,
  columns: readonly ImportColumn[],
  timeZone: string,
  guide: TemplateGuide,
  now = new Date(),
): Promise<Buffer> {
  const example = Object.fromEntries(
    columns.map((column) => {
      const value = exampleOf(column, now, timeZone);
      return [
        column.name,
        format !== 'json' && Array.isArray(value) ? value.join(', ') : value,
      ];
    }),
  );
  const transferColumns = columns.map((column) => ({
    key: column.name,
    ...((column.type === 'datetime' || column.type === 'date') && {
      type: column.type,
    }),
  }));
  if (format !== 'xlsx') {
    const writer = createWriter(format, transferColumns, timeZone);
    const chunks: Buffer[] = [];
    const collected = (async () => {
      for await (const chunk of writer.output) chunks.push(chunk as Buffer);
    })();
    await writer.write([example]);
    await writer.end();
    await collected;
    return Buffer.concat(chunks);
  }

  const workbook = new ExcelJS.Workbook();
  const data = workbook.addWorksheet(guide.sheets.data, {
    views: [{ state: 'frozen', ySplit: 1 }],
  });
  const help = workbook.addWorksheet(guide.sheets.columns);
  // The choices of the dropdowns: a range, not an inline list (Excel caps
  // that at 255 characters, and a comma would split a choice).
  const lists = workbook.addWorksheet('Lists', { state: 'veryHidden' });

  data.addRow(
    columns.map((column) =>
      column.type === 'datetime'
        ? zonedHeader(column.name, timeZone)
        : column.name,
    ),
  ).font = { bold: true };
  const line = data.addRow(
    columns.map((column) => {
      const value = example[column.name];
      if (column.type === 'date' && isDay(value)) {
        return new Date(`${value}T00:00:00Z`);
      }
      if (column.type !== 'datetime' || !(value instanceof Date)) {
        return cell(value, timeZone);
      }
      const { date, time } = wallClock(value, timeZone);
      return new Date(`${date}T${time}Z`);
    }),
  );
  columns.forEach((column, i) => {
    const sheetColumn = data.getColumn(i + 1);
    sheetColumn.width = Math.max(14, column.name.length + 4);
    if (column.type === 'datetime') {
      line.getCell(i + 1).numFmt = DATETIME_FORMAT;
      sheetColumn.width = Math.max(sheetColumn.width, 22);
    } else if (column.type === 'date') {
      line.getCell(i + 1).numFmt = DAY_FORMAT;
    }
    const choices =
      column.type === 'boolean'
        ? ['true', 'false']
        : column.type === 'text'
          ? column.options
          : undefined;
    if (!choices?.length) return;
    const listColumn = lists.getColumn(i + 1);
    choices.forEach((choice, row) => {
      lists.getCell(row + 1, i + 1).value = choice;
    });
    const range = `Lists!$${listColumn.letter}$1:$${listColumn.letter}$${choices.length}`;
    for (let row = 2; row <= TEMPLATE_ROWS + 1; row++) {
      data.getCell(row, i + 1).dataValidation = {
        type: 'list',
        allowBlank: !column.required,
        formulae: [range],
        showErrorMessage: true,
      };
    }
  });

  help.addRow([guide.note]).font = { italic: true };
  help.addRow([]);
  help.addRow(guide.headers).font = { bold: true };
  for (const column of columns) {
    help.addRow(guide.line(column));
  }
  help.columns.forEach((column, i) => {
    column.width = [24, 10, 14, 40, 24, 50][i] ?? 20;
  });
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

/**
 * The records of a file, with their row numbers (1: the first after the
 * header). Headers are the column names; values come as strings (CSV,
 * spreadsheets) or as written (JSON). A date cell of one of `dateColumns`
 * (the template's `date` columns) is read as its day, `2026-10-15`. A
 * `mapping` renames the file's headers first (or ignores a column): the
 * date columns and zones are those of the names it gives.
 */
export async function* readRecords(
  format: TransferFormat,
  input: Readable,
  {
    dateColumns = new Set(),
    mapping,
  }: { dateColumns?: ReadonlySet<string>; mapping?: ImportMapping } = {},
): AsyncGenerator<{ row: number; record: Record<string, unknown> }> {
  try {
    yield* records(format, input, dateColumns, mapping);
  } finally {
    // Read to the end, failed, or left early (too many errors): the source
    // (a file, an S3 download) is released either way.
    input.destroy();
  }
}

async function* records(
  format: TransferFormat,
  input: Readable,
  dateColumns: ReadonlySet<string>,
  mapping: ImportMapping | undefined,
): AsyncGenerator<{ row: number; record: Record<string, unknown> }> {
  let row = 0;
  if (format === 'csv') {
    // pipeline, not pipe: an error of the source reaches the parser (and the loop).
    const parser = pipeline(
      input,
      parse({
        // A mapping renames the headers (false: csv-parse drops the column).
        columns: mapping
          ? (headers: string[]) =>
              renameHeaders(headers, mapping).map((header) => header ?? false)
          : true,
        bom: true,
        skip_empty_lines: true,
        trim: true,
      }),
      () => undefined,
    );
    for await (const record of parser) {
      yield {
        row: ++row,
        record: fromCells(record as Record<string, unknown>),
      };
    }
    return;
  }
  if (format === 'json') {
    // One element of the top-level array at a time (stream-json), as the CSV
    // parser reads rows: the file is never held whole, and the row and byte
    // limits stop it as it is read (#618).
    const elements = pipeline(
      input,
      streamArray.withParserAsStream(),
      () => undefined,
    );
    try {
      for await (const { value } of elements as AsyncIterable<
        streamArray.StreamArrayItem<Record<string, unknown>>
      >) {
        yield {
          row: ++row,
          record: mapping ? renamedKeys(value, mapping) : value,
        };
      }
    } catch (error) {
      throw jsonFormatError(error);
    }
    return;
  }
  yield* xlsxRecords(input, dateColumns, mapping);
}

/**
 * A spreadsheet's first sheet, one row at a time (#618). The upload is
 * spooled to a temporary file first (never held whole in memory), its zip
 * directory checked (a zip bomb is refused before anything is unpacked),
 * then exceljs's streaming reader reads it, unless the file's entry order
 * would make that reader wrong: see `streamable()`. Such a file (and one
 * with several sheets) is read whole as before, still checked first.
 */
async function* xlsxRecords(
  input: Readable,
  dateColumns: ReadonlySet<string>,
  mapping: ImportMapping | undefined,
): AsyncGenerator<{ row: number; record: Record<string, unknown> }> {
  const dir = await mkdtemp(join(tmpdir(), 'import-xlsx-'));
  try {
    const path = join(dir, 'upload.xlsx');
    await pipelineAsync(input, createWriteStream(path));
    const entries = await zipEntries(path);
    if (streamable(entries)) {
      const reader = new ExcelJS.stream.xlsx.WorkbookReader(
        createReadStream(path),
        {
          sharedStrings: 'cache',
          styles: 'cache',
          hyperlinks: 'ignore',
          worksheets: 'emit',
          entries: 'ignore',
        },
      );
      // The first sheet only, as a loaded workbook's worksheets[0].
      const sheets = reader[Symbol.asyncIterator]();
      try {
        const first = await sheets.next();
        if (!first.done) {
          yield* sheetRecords(
            first.value as AsyncIterable<ExcelJS.Row>,
            dateColumns,
            mapping,
          );
        }
      } finally {
        await sheets.return?.(undefined);
      }
      return;
    }
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load((await readFile(path)) as unknown as ArrayBuffer);
    const sheet = workbook.worksheets[0];
    if (!sheet) return;
    yield* sheetRecords(loadedRows(sheet), dateColumns, mapping);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A loaded sheet's rows, as eachRow() (the rows with values), without a second copy of them. */
function* loadedRows(sheet: ExcelJS.Worksheet) {
  for (let number = 1; number <= sheet.rowCount; number++) {
    const line = sheet.findRow(number);
    if (line) yield line;
  }
}

/** The records of a sheet's rows: the first row with values is the header. */
async function* sheetRecords(
  rows: Iterable<ExcelJS.Row> | AsyncIterable<ExcelJS.Row>,
  dateColumns: ReadonlySet<string>,
  mapping: ImportMapping | undefined,
): AsyncGenerator<{ row: number; record: Record<string, unknown> }> {
  let row = 0;
  let headers: (string | null)[] | undefined;
  for await (const line of rows) {
    if (!line.hasValues) continue;
    const cells = (line.values as unknown[]).slice(1);
    if (!headers) {
      headers = renameHeaders(
        cells.map((header) =>
          header === null || header === undefined
            ? ''
            : cellText(header).trim(),
        ),
        mapping,
      );
      continue;
    }
    yield {
      row: ++row,
      record: fromCells(
        Object.fromEntries(
          headers.flatMap((header, i) => {
            if (header === null) return [];
            const value = cells[i];
            if (value === null || value === undefined) return [[header, '']];
            if (value instanceof Date) {
              // A date cell: the day of a date column; the wall-clock time
              // (as UTC) of a zoned column; else ISO 8601.
              if (dateColumns.has(header)) {
                return [[header, value.toISOString().slice(0, 10)]];
              }
              if (columnOf(header).zone) {
                return [
                  [header, value.toISOString().slice(0, 23).replace('T', ' ')],
                ];
              }
            }
            return [[header, cellText(value)]];
          }),
        ),
      ),
    };
  }
}

/** A JSON element under the mapping's names; an ignored key is dropped. */
function renamedKeys(
  value: Record<string, unknown>,
  mapping: ImportMapping,
): Record<string, unknown> {
  const keys = Object.keys(value);
  const names = renameHeaders(keys, mapping);
  return Object.fromEntries(
    keys.flatMap((key, i) => {
      const name = names[i];
      // JSON carries no zone: a target's is not part of the key.
      return name === null || name === undefined
        ? []
        : [[columnOf(name).key, value[key]]];
    }),
  );
}

/**
 * A record as its cells mean it, so an exported file imports back to what
 * was exported: zoned columns (`createdAt (Asia/Dubai)`) under their own
 * name, the local times read in that zone (ISO 8601 UTC); the quote an
 * export puts before text a spreadsheet would run (`'=1+1`, `'+63 912`)
 * removed, as Excel removes the one a person types.
 */
function fromCells(record: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(record).map(([header, value]) => {
      const { key, zone } = columnOf(header);
      if (typeof value !== 'string') return [key, value];
      const text = QUOTED_FORMULA.test(value) ? value.slice(1) : value;
      // An empty cell of a zoned column is no value (an optional datetime exported empty), not a bad one.
      if (zone && text.trim() === '') return [key, undefined];
      return [key, zone ? (instantOf(text, zone) ?? text) : text];
    }),
  );
}

/** A spreadsheet cell as text: dates in ISO 8601, formulas by their result, rich text joined. */
function cellText(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'object' && value !== null) {
    const cell = value as {
      result?: unknown;
      text?: unknown;
      richText?: { text: string }[];
    };
    if (cell.richText) return cell.richText.map((part) => part.text).join('');
    if (typeof cell.text === 'string') return cell.text;
    if (cell.result !== undefined) return cellText(cell.result);
    return JSON.stringify(value);
  }
  return String(value);
}

/** A file that isn't the format it claims. */
export class FormatError extends Error {}

/**
 * stream-json's errors, as the person reads them: not an array, or the
 * place it stops parsing (data-transfer.service.ts shows "… is not valid
 * JSON" to them). Anything else (the source failing) is left as it is.
 */
function jsonFormatError(error: unknown) {
  if (!(error instanceof Error)) return error;
  if (error.message === 'Top-level object should be an array.') {
    return new FormatError('A JSON import is an array of objects.');
  }
  if (error.message.startsWith('Parser cannot parse input')) {
    const detail = error.message.replace(/^Parser cannot parse input:?\s*/, '');
    return new FormatError(
      `The file is not valid JSON${detail ? `: ${detail}` : '.'}`,
    );
  }
  return error;
}

/**
 * Recognizes an upload by its first bytes: Excel by the zip signature (an
 * .xlsx is a zip), JSON by its opening bracket, CSV as plain text (no
 * control characters but tabs and line breaks). Anything else: refused.
 */
export function detectTextFormat(bytes: Buffer): string | undefined {
  if (bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
    return CONTENT_TYPES.xlsx;
  }
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFD]/.test(text)) {
    return undefined;
  }
  return text.trimStart().startsWith('[')
    ? 'application/json'
    : 'text/csv; charset=utf-8';
}

/** The format of a stored upload, from the type the storage detected. */
export function formatOf(contentType: string): TransferFormat | undefined {
  if (contentType.startsWith('text/csv')) return 'csv';
  if (contentType.startsWith('application/json')) return 'json';
  if (
    contentType.includes('spreadsheetml') ||
    contentType.startsWith('application/zip')
  )
    return 'xlsx';
  return undefined;
}

/** What a spreadsheet may unpack to, and how many files it may hold. */
const MAX_UNZIPPED_BYTES = 300 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 2_000;

/** A zip entry as its central directory lists it. */
export interface ZipEntry {
  name: string;
  /** Where its local header starts: the order a streaming reader meets it in. */
  offset: number;
}

/** The end-of-central-directory record is in the last 22 bytes plus a comment of at most 65,535. */
const ZIP_TAIL = 22 + 0xffff;
/** A directory of MAX_ZIP_ENTRIES entries with long names stays far below this. */
const MAX_DIRECTORY_BYTES = 4 * 1024 * 1024;

/**
 * The entries of a zip file (an .xlsx) on disk, from its central directory
 * alone (the end of the file), refusing one that declares more than
 * MAX_UNZIPPED_BYTES or MAX_ZIP_ENTRIES: a zip bomb would fill the
 * worker's memory or disk.
 */
export async function zipEntries(path: string): Promise<ZipEntry[]> {
  const invalid = () =>
    new FormatError('The spreadsheet is not a valid .xlsx file.');
  const file = await open(path, 'r');
  try {
    const { size } = await file.stat();
    const tailLength = Math.min(size, ZIP_TAIL);
    const tail = Buffer.alloc(tailLength);
    await file.read(tail, 0, tailLength, size - tailLength);
    const end = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (end < 0 || end + 22 > tail.length) throw invalid();
    const count = tail.readUInt16LE(end + 10);
    const length = tail.readUInt32LE(end + 12);
    const start = tail.readUInt32LE(end + 16);
    if (count > MAX_ZIP_ENTRIES || length > MAX_DIRECTORY_BYTES) {
      throw new FormatError('The spreadsheet is too large to import.');
    }
    if (start + length > size) throw invalid();
    const directory = Buffer.alloc(length);
    await file.read(directory, 0, length, start);
    const entries: ZipEntry[] = [];
    let total = 0;
    for (let i = 0, at = 0; i < count; i++) {
      if (
        at + 46 > directory.length ||
        directory.readUInt32LE(at) !== 0x02014b50
      ) {
        throw invalid();
      }
      total += directory.readUInt32LE(at + 24);
      if (total > MAX_UNZIPPED_BYTES) {
        throw new FormatError('The spreadsheet is too large to import.');
      }
      const nameLength = directory.readUInt16LE(at + 28);
      entries.push({
        name: directory.toString('utf8', at + 46, at + 46 + nameLength),
        offset: directory.readUInt32LE(at + 42),
      });
      at +=
        46 +
        nameLength +
        directory.readUInt16LE(at + 30) +
        directory.readUInt16LE(at + 32);
    }
    return entries;
  } finally {
    await file.close();
  }
}

const SHEET_ENTRY = /^xl\/worksheets\/sheet\d+\.xml$/;

/**
 * Whether exceljs's streaming reader (4.4) reads this file right, from the
 * order of its entries (the documented entry-order problem, #618). The
 * reader parses a sheet as it meets it once it has the shared strings and
 * the workbook's relationships, else it spools the sheet to a temporary
 * file and parses it at the end: both right. But a sheet it parses at once
 * before `xl/styles.xml` has no number formats yet, so its date cells come
 * out as serial numbers (46310, not 2026-10-15), silently. That order, and
 * a workbook of several sheets (the reader's first could be another than
 * the workbook's first), are read whole instead.
 */
export function streamable(entries: readonly ZipEntry[]): boolean {
  const at = (name: string) =>
    entries.find((entry) => entry.name === name)?.offset;
  const sheets = entries.filter((entry) => SHEET_ENTRY.test(entry.name));
  if (sheets.length !== 1) return false;
  const sheet = sheets[0]!.offset;
  const strings = at('xl/sharedStrings.xml');
  const rels = at('xl/_rels/workbook.xml.rels');
  const styles = at('xl/styles.xml');
  const parsedAtOnce =
    strings !== undefined &&
    strings < sheet &&
    rels !== undefined &&
    rels < sheet;
  return !parsedAtOnce || styles === undefined || styles < sheet;
}
