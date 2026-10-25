import { createReadStream, createWriteStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { deserialize, serialize } from 'node:v8';
import type { TransferFormat } from './data-transfer.types.js';
import { readRecords } from './formats.js';

interface ImportSpoolRow {
  row: number;
  record: string;
}

export class ImportSpoolLimitError extends Error {
  constructor() {
    super('The file has too many rows to import.');
    this.name = 'ImportSpoolLimitError';
  }
}

/** Parse and validate the complete source into a bounded-memory private spool. */
export async function spoolImportRecords(
  format: TransferFormat,
  sourcePath: string,
  spoolPath: string,
  options: {
    dateColumns: ReadonlySet<string>;
    maxRows: number;
    scratchDirectory: string;
  },
) {
  let headers: string[] = [];
  let rowCount = 0;
  const lines = async function* () {
    for await (const { row, record } of readRecords(
      format,
      createReadStream(sourcePath),
      {
        dateColumns: options.dateColumns,
        scratchDirectory: options.scratchDirectory,
        onHeaders: (names) => {
          headers = names;
        },
      },
    )) {
      if (row > options.maxRows) throw new ImportSpoolLimitError();
      rowCount = row;
      yield `${JSON.stringify({
        row,
        record: serialize(record).toString('base64'),
      } satisfies ImportSpoolRow)}\n`;
    }
  };
  await pipeline(
    Readable.from(lines()),
    createWriteStream(spoolPath, { mode: 0o600 }),
  );
  return { headers, rowCount };
}

/** Restore normalized rows from the spool, preserving own undefined keys. */
export async function* readImportSpool(path: string) {
  const input = createReadStream(path);
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      const saved = JSON.parse(line) as ImportSpoolRow;
      const record = deserialize(Buffer.from(saved.record, 'base64')) as Record<
        string,
        unknown
      >;
      yield { row: saved.row, record };
    }
  } finally {
    lines.close();
    input.destroy();
  }
}
