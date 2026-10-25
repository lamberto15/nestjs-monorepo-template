import { Readable } from 'node:stream';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import {
  cellColumnIndex,
  columnIndex,
  sharedStringParser,
} from './xlsx-reader.js';
import type { TransferFormat } from './data-transfer.types.js';
import {
  createWriter,
  inspectRecords,
  instantOf,
  isoInZone,
  localDateTime,
  readRecords,
} from './formats.js';

describe('isoInZone', () => {
  const moment = new Date('2026-10-15T14:30:05.123Z');

  it.each([
    ['UTC', '2026-10-15T14:30:05.123+00:00'],
    ['Asia/Dubai', '2026-10-15T18:30:05.123+04:00'],
    ['Asia/Kolkata', '2026-10-15T20:00:05.123+05:30'],
    ['America/New_York', '2026-10-15T10:30:05.123-04:00'],
  ])('writes the wall-clock time and offset of %s', (zone, expected) => {
    expect(isoInZone(moment, zone)).toBe(expected);
  });

  it('follows daylight saving time', () => {
    expect(
      isoInZone(new Date('2026-01-15T14:30:00Z'), 'America/New_York'),
    ).toBe('2026-01-15T09:30:00.000-05:00');
  });

  it('writes midnight as 00, on the local date', () => {
    expect(isoInZone(new Date('2026-10-14T20:00:00Z'), 'Asia/Dubai')).toBe(
      '2026-10-15T00:00:00.000+04:00',
    );
  });

  it('stays the same moment when read back', () => {
    for (const zone of ['Asia/Dubai', 'America/New_York', 'Asia/Singapore']) {
      expect(new Date(isoInZone(moment, zone)).getTime()).toBe(
        moment.getTime(),
      );
    }
  });
});

describe('localDateTime', () => {
  it('writes the local time as spreadsheets read a date', () => {
    expect(
      localDateTime(new Date('2026-10-15T14:26:23.799Z'), 'Asia/Singapore'),
    ).toBe('2026-10-15 22:26:23');
  });
});

describe('instantOf', () => {
  it.each([
    ['2026-10-15 22:26:23', 'Asia/Singapore', '2026-10-15T14:26:23.000Z'],
    ['2026-10-15T22:26:23.799', 'Asia/Singapore', '2026-10-15T14:26:23.799Z'],
    ['2026-10-15 18:30', 'Asia/Dubai', '2026-10-15T14:30:00.000Z'],
    ['2026-01-15 09:30:00', 'America/New_York', '2026-01-15T14:30:00.000Z'],
    ['2026-07-15 09:30:00', 'America/New_York', '2026-07-15T13:30:00.000Z'],
  ])('reads %s in %s', (text, zone, expected) => {
    expect(instantOf(text, zone)).toBe(expected);
  });

  it('takes the earlier moment in the hour the clock goes back', () => {
    // New York, 2026-11-01: 01:30 happens at -04:00, then again at -05:00.
    expect(instantOf('2026-11-01 01:30:00', 'America/New_York')).toBe(
      '2026-11-01T05:30:00.000Z',
    );
  });

  it('moves a time the clock skips forward by the gap', () => {
    // New York, 2026-03-08: 02:30 does not exist; read at the old offset.
    expect(instantOf('2026-03-08 02:30:00', 'America/New_York')).toBe(
      '2026-03-08T07:30:00.000Z',
    );
  });

  it('leaves what is not a local time to the schema', () => {
    for (const text of [
      '2026-10-15T22:26:23+08:00',
      '2026-10-15T14:26:23Z',
      '2026-02-30 10:00:00',
      'tomorrow',
    ]) {
      expect(instantOf(text, 'Asia/Singapore')).toBeUndefined();
    }
  });
});

describe('date-time columns', () => {
  const columns = [
    { key: 'title' },
    { key: 'createdAt', type: 'datetime' },
  ] as const;
  const createdAt = new Date('2026-10-15T14:26:23.799Z');

  async function roundTrip(format: TransferFormat) {
    const writer = createWriter(format, columns, 'Asia/Singapore');
    const chunks: Buffer[] = [];
    const collected = (async () => {
      for await (const chunk of writer.output) chunks.push(chunk as Buffer);
    })();
    await writer.write([{ title: 'One', createdAt }]);
    await writer.end();
    await collected;
    const file = Buffer.concat(chunks);
    const records = [];
    for await (const { record } of readRecords(format, Readable.from(file))) {
      records.push(record);
    }
    return { file, records };
  }

  it('writes CSV in local time, the zone in the header', async () => {
    const { file } = await roundTrip('csv');
    expect(file.toString('utf8').replace(/^\uFEFF/, '')).toBe(
      'title,createdAt (Asia/Singapore)\nOne,2026-10-15 22:26:23\n',
    );
  });

  it.each(['csv', 'xlsx'] as const)(
    'imports %s back to the same moment, under the column name',
    async (format) => {
      const { records } = await roundTrip(format);
      expect(records).toEqual([
        {
          title: 'One',
          // CSV keeps seconds; an Excel date cell keeps the milliseconds.
          createdAt:
            format === 'csv'
              ? '2026-10-15T14:26:23.000Z'
              : '2026-10-15T14:26:23.799Z',
        },
      ]);
    },
  );

  it('keeps JSON exact, with the offset', async () => {
    const { records } = await roundTrip('json');
    expect(records).toEqual([
      { title: 'One', createdAt: '2026-10-15T22:26:23.799+08:00' },
    ]);
  });
});

describe('formula-like text', () => {
  const columns = [{ key: 'title' }] as const;
  const titles = ['=1+1', '+63 912', '-5', '@cmd', "'quoted", 'plain'];

  async function roundTrip(format: TransferFormat) {
    const writer = createWriter(format, columns, 'UTC');
    const chunks: Buffer[] = [];
    const collected = (async () => {
      for await (const chunk of writer.output) chunks.push(chunk as Buffer);
    })();
    await writer.write(titles.map((title) => ({ title })));
    await writer.end();
    await collected;
    const file = Buffer.concat(chunks);
    const records = [];
    for await (const { record } of readRecords(format, Readable.from(file))) {
      records.push(record);
    }
    return { file, records };
  }

  it('is quoted in CSV so a spreadsheet shows it instead of running it', async () => {
    const { file } = await roundTrip('csv');
    expect(file.toString('utf8').replace(/^\uFEFF/, '')).toBe(
      "title\n'=1+1\n'+63 912\n'-5\n'@cmd\n'quoted\nplain\n",
    );
  });

  it.each(['csv', 'xlsx'] as const)(
    'comes back from %s as it was written (the quote is not part of the value)',
    async (format) => {
      const { records } = await roundTrip(format);
      expect(records.map((record) => record.title)).toEqual(titles);
    },
  );
});

describe('date columns', () => {
  const columns = [{ key: 'day', type: 'date' }] as const;

  async function roundTrip(format: TransferFormat, dateColumns?: Set<string>) {
    const writer = createWriter(format, columns, 'UTC');
    const chunks: Buffer[] = [];
    const collected = (async () => {
      for await (const chunk of writer.output) chunks.push(chunk as Buffer);
    })();
    await writer.write([{ day: '2026-01-05' }, { day: 'soon' }]);
    await writer.end();
    await collected;
    const file = Buffer.concat(chunks);
    const records = [];
    for await (const { record } of readRecords(format, Readable.from(file), {
      dateColumns,
    })) {
      records.push(record.day);
    }
    return records;
  }

  it.each(['csv', 'json'] as const)('is text in %s', async (format) => {
    expect(await roundTrip(format)).toEqual(['2026-01-05', 'soon']);
  });

  it('is a date cell in Excel, read back as the day under a date column', async () => {
    expect(await roundTrip('xlsx', new Set(['day']))).toEqual([
      '2026-01-05',
      'soon',
    ]);
    // Not known as a date column: the cell's moment, in ISO 8601.
    expect(await roundTrip('xlsx')).toEqual([
      '2026-01-05T00:00:00.000Z',
      'soon',
    ]);
  });
});

describe('streaming imports', () => {
  it('rejects invalid cell addresses before they can allocate oversized rows', () => {
    expect(() => columnIndex('ZZZZZZ1')).toThrow('invalid cell reference');
    expect(() => columnIndex('A1048577')).toThrow('invalid cell reference');
  });

  it('infers a missing cell reference from the preceding cell while honoring explicit gaps', () => {
    expect(cellColumnIndex(undefined, 0)).toBe(0);
    expect(cellColumnIndex('D1', 1)).toBe(3);
    expect(cellColumnIndex(undefined, 4)).toBe(4);
    expect(() => cellColumnIndex(undefined, 16_384)).toThrow(
      'invalid cell reference',
    );
  });

  it('reads only shared-string text runs, excluding pretty-print whitespace and phonetics', () => {
    const strings: string[] = [];
    sharedStringParser((value) => strings.push(value))
      .write(
        '<x:sst xmlns:x="urn:test"><x:si>\n <x:t>Hello</x:t>\n <x:r><x:t> rich</x:t></x:r><x:rPh><x:t>phonetic</x:t></x:rPh>\n</x:si></x:sst>',
      )
      .close();
    expect(strings).toEqual(['Hello rich']);
  });

  it('streams a JSON array across arbitrary input chunks and reports preflight headers/count', async () => {
    const input = Readable.from(['[{"a":', '1},{"a":2}]']);
    const rows = [];
    for await (const { record } of readRecords('json', input))
      rows.push(record);
    expect(rows).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('preflights header-only files and stops at the first row above the limit', async () => {
    await expect(
      inspectRecords('csv', Readable.from('name,createdAt (Asia/Dubai)\n')),
    ).resolves.toEqual({
      headers: ['name', 'createdAt'],
      rowCount: 0,
    });
    await expect(
      inspectRecords('json', Readable.from('[{"id":1},{"id":2}]'), {
        maxRows: 1,
      }),
    ).rejects.toThrow('too many rows');
  });

  it('reads 1904-system Excel dates and skips entirely empty rows', async () => {
    const workbook = new ExcelJS.Workbook();
    workbook.properties.date1904 = true;
    const sheet = workbook.addWorksheet('Data');
    sheet.addRow(['day', 'calculation', 'description']);
    sheet.addRow([]);
    const date = sheet.addRow([
      new Date('1904-01-02T00:00:00.000Z'),
      { formula: '1+1', result: 2 },
      { richText: [{ text: 'rich ' }, { text: 'text' }] },
    ]);
    date.getCell(1).numFmt = 'yyyy-mm-dd';
    const file = Buffer.from(await workbook.xlsx.writeBuffer());
    const rows = [];
    for await (const { record } of readRecords('xlsx', Readable.from(file), {
      dateColumns: new Set(['day']),
    }))
      rows.push(record);
    expect(rows).toEqual([
      { day: '1904-01-02', calculation: '2', description: 'rich text' },
    ]);
  });

  it('stores and cleans its XLSX SQLite workspace under the configured scratch directory', async () => {
    const scratchDirectory = await mkdtemp(join(tmpdir(), 'transfer-test-'));
    try {
      const workbook = new ExcelJS.Workbook();
      workbook.addWorksheet('Data').addRows([['name'], ['value']]);
      const file = Buffer.from(await workbook.xlsx.writeBuffer());
      await expect(
        inspectRecords('xlsx', Readable.from(file), { scratchDirectory }),
      ).resolves.toEqual({ headers: ['name'], rowCount: 1 });
      expect(await readdir(scratchDirectory)).toEqual([]);
      const rows = [];
      for await (const { record } of readRecords('xlsx', Readable.from(file), {
        scratchDirectory,
      }))
        rows.push(record);
      expect(rows).toEqual([{ name: 'value' }]);
      expect(await readdir(scratchDirectory)).toEqual([]);
      await expect(
        inspectRecords('xlsx', Readable.from('not a zip'), {
          scratchDirectory,
        }),
      ).rejects.toThrow();
      expect(await readdir(scratchDirectory)).toEqual([]);
    } finally {
      await rm(scratchDirectory, { recursive: true, force: true });
    }
  });
});
