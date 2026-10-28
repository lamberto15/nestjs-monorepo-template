import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import ExcelJS from 'exceljs';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { refusal, valuesSet } from './data-transfer.processor.js';
import type { ImportColumn } from './data-transfer.types.js';
import { createTemplate, readRecords, type TemplateGuide } from './formats.js';
import { columnsOf, exampleOf } from './import-columns.js';
import { mappingProblems, staleTargets } from './import-mapping.js';

const row = z.object({
  title: z.string().trim().min(1).max(200).meta({ example: 'Hello' }),
  body: z.string().max(10_000).default(''),
  status: z.enum(['draft', 'published']),
  amount: z.number().int().min(1).optional(),
  dueAt: z.iso.datetime().describe('When it is due'),
  day: z.iso.date().nullable(),
  tags: z.array(z.string()).max(3),
});

describe('columnsOf', () => {
  it('describes each column from the row schema', () => {
    expect(columnsOf(row)).toEqual([
      {
        name: 'title',
        type: 'text',
        required: true,
        min: 1,
        max: 200,
        example: 'Hello',
      },
      { name: 'body', type: 'text', required: false, max: 10_000 },
      {
        name: 'status',
        type: 'text',
        required: true,
        options: ['draft', 'published'],
      },
      { name: 'amount', type: 'number', required: false, min: 1 },
      {
        name: 'dueAt',
        type: 'datetime',
        required: true,
        description: 'When it is due',
      },
      { name: 'day', type: 'date', required: true },
      { name: 'tags', type: 'list', required: true, max: 3 },
    ]);
  });

  it('describes nothing for a schema that is not an object', () => {
    expect(columnsOf(z.string())).toEqual([]);
  });
});

describe('exampleOf', () => {
  const now = new Date('2026-10-15T20:30:00Z');
  const column = (extra: Partial<ImportColumn>): ImportColumn => ({
    name: 'x',
    type: 'text',
    required: true,
    ...extra,
  });

  it.each<[Partial<ImportColumn>, unknown]>([
    [{ example: 'Hello' }, 'Hello'],
    [{ options: ['draft', 'published'] }, 'draft'],
    [{ type: 'number', min: 5 }, 5],
    [{ type: 'boolean' }, true],
    [{ type: 'list', options: ['a', 'b'] }, ['a']],
    // The local date: already the 16th in Dubai.
    [{ type: 'date' }, '2026-10-16'],
    [{ type: 'datetime' }, now],
  ])('gives %j the example %j', (extra, expected) => {
    expect(exampleOf(column(extra), now, 'Asia/Dubai')).toEqual(expected);
  });
});

describe('createTemplate', () => {
  const guide: TemplateGuide = {
    sheets: { data: 'Data', columns: 'Columns' },
    headers: ['Column', 'Required'],
    line: (column) => [column.name, column.required ? 'Yes' : 'No'],
    note: 'Row 2 is an example.',
  };
  const columns = columnsOf(row);
  const now = new Date('2026-10-15T14:26:23Z');

  it('writes the headers and an example row that the row schema accepts', async () => {
    for (const format of ['csv', 'json', 'xlsx'] as const) {
      const file = await createTemplate(
        format,
        columns,
        'Asia/Singapore',
        guide,
        now,
      );
      const records = [];
      for await (const { record } of readRecords(format, Readable.from(file), {
        dateColumns: new Set(['day']),
      })) {
        records.push(record);
      }
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        title: 'Hello',
        status: 'draft',
        // The local day (an Excel date cell, read as a day).
        day: '2026-10-15',
        // The local time, read back in the header's zone: the same moment.
        dueAt:
          format === 'json'
            ? '2026-10-15T22:26:23.000+08:00'
            : '2026-10-15T14:26:23.000Z',
      });
    }
  });

  it('gives Excel the guide, dropdowns for choices and a date cell', async () => {
    const file = await createTemplate(
      'xlsx',
      columns,
      'Asia/Singapore',
      guide,
      now,
    );
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(file as unknown as ArrayBuffer);
    const data = workbook.getWorksheet('Data')!;
    expect(data.getRow(1).values).toEqual([
      undefined,
      'title',
      'body',
      'status',
      'amount',
      'dueAt (Asia/Singapore)',
      'day',
      'tags',
    ]);
    expect(data.getCell('E2').value).toEqual(new Date('2026-10-15T22:26:23Z'));
    expect(data.getCell('F2').value).toEqual(new Date('2026-10-15T00:00:00Z'));
    expect(data.getCell('F2').numFmt).toBe('yyyy-mm-dd');
    expect(data.getCell('C2').dataValidation).toMatchObject({
      type: 'list',
      formulae: ['Lists!$C$1:$C$2'],
    });
    expect(data.getCell('C500').dataValidation?.type).toBe('list');
    expect(data.getCell('A2').dataValidation).toBeUndefined();
    const help = workbook.getWorksheet('Columns')!;
    expect(help.getCell('A1').value).toBe('Row 2 is an example.');
    expect(help.getRow(3).values).toEqual([undefined, 'Column', 'Required']);
    expect(help.getRow(4).values).toEqual([undefined, 'title', 'Yes']);
  });
});

describe('a row as a write route sees it', () => {
  it('sets nothing with an empty value', () => {
    const at = new Date();
    expect(
      valuesSet({ title: 'x', body: '', custom: {}, at, tags: [], n: null }),
    ).toEqual({
      title: 'x',
      body: undefined,
      custom: undefined,
      at,
      tags: undefined,
      n: undefined,
    });
  });

  it('refuses the row on a 4xx, naming the fields', () => {
    expect(
      refusal(
        new BadRequestException({
          code: 'validation_failed',
          errors: [{ path: 'custom.amount', message: 'Too big' }],
        }),
        3,
      ),
    ).toEqual([{ row: 3, path: 'custom.amount', message: 'Too big' }]);
    expect(
      refusal(
        new ForbiddenException({
          code: 'field_forbidden',
          message: 'You may not set: body.',
          fields: ['body'],
        }),
        4,
      ),
    ).toEqual([{ row: 4, path: 'body', message: 'You may not set: body.' }]);
    expect(refusal(new ConflictException('Taken.'), 5)).toEqual([
      { row: 5, path: '', message: 'Taken.' },
    ]);
  });

  it('fails the import on anything else', () => {
    expect(refusal(new Error('connection lost'), 1)).toBeUndefined();
  });
});

describe('import mappings', () => {
  const columns: ImportColumn[] = [
    { name: 'title', type: 'text', required: true },
    { name: 'dueAt', type: 'datetime', required: false },
    { name: 'custom.region', type: 'text', required: false },
  ];

  it('accepts renamed, ignored and custom-field targets, with a zone on a date-time', () => {
    expect(
      mappingProblems(
        {
          Name: 'title',
          When: 'dueAt (Asia/Dubai)',
          Area: 'custom.region',
          Internal: null,
        },
        columns,
      ),
    ).toEqual([]);
  });

  it('refuses a target twice, with or without the zone', () => {
    expect(
      mappingProblems(
        { A: 'title', B: 'title', C: 'dueAt', D: 'dueAt (UTC)' },
        columns,
      ),
    ).toEqual([
      '"A" and "B" both map to "title".',
      '"C" and "D" both map to "dueAt".',
    ]);
  });

  it('refuses a target that is not a column the caller may fill, or a zone on a text', () => {
    expect(
      mappingProblems({ A: 'ownerId', B: 'title (UTC)' }, columns),
    ).toEqual([
      '"A" maps to "ownerId", which you cannot import.',
      '"title" is not a date-time column: it takes no zone.',
    ]);
  });

  it('names the targets a changed schema or permission no longer allows', () => {
    expect(
      staleTargets(
        { A: 'title', B: 'custom.gone', C: 'dueAt (UTC)', D: null },
        columns.filter((column) => column.name !== 'dueAt'),
      ),
    ).toEqual(['custom.gone', 'dueAt']);
  });
});
