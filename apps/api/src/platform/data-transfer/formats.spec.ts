import ExcelJS from 'exceljs';
import { Readable } from 'node:stream';
import type { TransferFormat } from './data-transfer.types.js';
import {
  createWriter,
  instantOf,
  isoInZone,
  localDateTime,
  readRecords,
} from './formats.js';
import { MappingError } from './import-mapping.js';

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

describe('JSON imports', () => {
  /** The file as the upload delivers it: in `size`-byte chunks. */
  async function read(text: string, size = 3) {
    const bytes = Buffer.from(text);
    const chunks: Buffer[] = [];
    for (let at = 0; at < bytes.length; at += size) {
      chunks.push(bytes.subarray(at, at + size));
    }
    const rows: { row: number; record: Record<string, unknown> }[] = [];
    for await (const item of readRecords('json', Readable.from(chunks))) {
      rows.push(item);
    }
    return rows;
  }

  it('reads one element at a time, whatever the chunks cut (a character included)', async () => {
    expect(
      await read('[{"title":"héllo ✓","n":1},{"title":null,"tags":["a"]}]', 1),
    ).toEqual([
      { row: 1, record: { title: 'héllo ✓', n: 1 } },
      { row: 2, record: { title: null, tags: ['a'] } },
    ]);
    expect(await read('[]')).toEqual([]);
  });

  it('refuses a file that is not an array, as before', async () => {
    await expect(read('{"title":"x"}')).rejects.toThrow(
      /^A JSON import is an array of objects\.$/,
    );
  });

  it('says where a malformed file stops being JSON', async () => {
    await expect(read('[{"title":"x"},{"title":}]')).rejects.toThrow(
      /^The file is not valid JSON: expected a value$/,
    );
    await expect(read('[{"title":"x"}] junk')).rejects.toThrow(
      /^The file is not valid JSON/,
    );
  });
});

describe('readRecords with a column mapping', () => {
  const read = async (
    format: TransferFormat,
    file: string | Buffer,
    options: Parameters<typeof readRecords>[2],
  ) => {
    const records = [];
    for await (const { record } of readRecords(
      format,
      Readable.from([file]),
      options,
    )) {
      records.push(record);
    }
    return records;
  };

  it('renames, ignores and reads the zone a target names; other columns keep their name', async () => {
    const csv =
      'Name,When,Internal,Area,body\nOne,2026-10-15 18:30:00,x,North,Hi\n';
    expect(
      await read('csv', csv, {
        mapping: {
          Name: 'title',
          When: 'dueAt (Asia/Dubai)',
          Internal: null,
          Area: 'custom.region',
        },
      }),
    ).toEqual([
      {
        title: 'One',
        dueAt: '2026-10-15T14:30:00.000Z',
        'custom.region': 'North',
        body: 'Hi',
      },
    ]);
  });

  it('renames JSON keys, without a zone', async () => {
    const json = JSON.stringify([{ Name: 'One', When: '2026-10-15', Skip: 1 }]);
    expect(
      await read('json', json, {
        mapping: { Name: 'title', When: 'dueAt (UTC)', Skip: null },
      }),
    ).toEqual([{ title: 'One', dueAt: '2026-10-15' }]);
  });

  it('reads an Excel date cell as the day under a date target', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Sheet1');
    sheet.addRow(['Birthday']);
    sheet.addRow([new Date('2026-01-05T00:00:00Z')]);
    const file = Buffer.from(await workbook.xlsx.writeBuffer());
    expect(
      await read('xlsx', file, {
        dateColumns: new Set(['day']),
        mapping: { Birthday: 'day' },
      }),
    ).toEqual([{ day: '2026-01-05' }]);
  });

  it('refuses two columns that end up with one name', async () => {
    await expect(
      read('csv', 'title,Name\nA,B\n', { mapping: { Name: 'title' } }),
    ).rejects.toThrow(MappingError);
  });
});
