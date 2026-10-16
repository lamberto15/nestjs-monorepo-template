import { PgDialect } from 'drizzle-orm/pg-core';
import { notes } from '../../features/notes/notes.tables.js';
import type { SQL } from 'drizzle-orm';
import { customFilterFields } from './custom-field.list.js';
import type { CustomFieldDefinition } from './custom-field.types.js';
import { coerceImported } from './custom-field.values.js';

const dialect = new PgDialect();
const render = (query: Parameters<PgDialect['sqlToQuery']>[0]) =>
  dialect.sqlToQuery(query);

const field = (
  key: string,
  type: CustomFieldDefinition['type'],
  extra: Partial<CustomFieldDefinition> = {},
): CustomFieldDefinition => ({
  id: key,
  subject: 'Note',
  key,
  label: key,
  description: null,
  type,
  options: null,
  required: false,
  defaultValue: null,
  validation: null,
  position: 0,
  filterable: true,
  sortable: true,
  active: true,
  ...extra,
});

describe('customFilterFields', () => {
  const { fields, select } = customFilterFields(
    [
      field('region', 'select', { options: [{ value: 'eu', label: 'EU' }] }),
      field('amount', 'number'),
      field('due', 'date'),
      field('done', 'boolean'),
      field('tags', 'multiSelect', { options: [{ value: 'a', label: 'A' }] }),
      field('note', 'text', { filterable: false, sortable: false }),
      field('old', 'text', { active: false }),
    ],
    notes.custom,
  );

  it('declares active fields with typed expressions; every active one can be selected', () => {
    expect(Object.keys(fields)).toEqual([
      'custom.region',
      'custom.amount',
      'custom.due',
      'custom.done',
      'custom.tags',
    ]);
    expect(select).toEqual([
      'custom.region',
      'custom.amount',
      'custom.due',
      'custom.done',
      'custom.tags',
      'custom.note',
    ]);
    expect(render(fields['custom.region'].column as SQL).sql).toBe(
      `("notes"."custom"->>'region')`,
    );
    expect(render(fields['custom.amount'].column as SQL).sql).toBe(
      `(("notes"."custom"->>'amount')::numeric)`,
    );
    expect(render(fields['custom.due'].column as SQL).sql).toBe(
      `(("notes"."custom"->>'due')::date)`,
    );
    expect(fields['custom.due'].type).toBe('date');
    expect(fields['custom.region']).toMatchObject({
      type: 'enum',
      values: ['eu'],
    });
    expect(fields['custom.tags'].sortable).toBe(false);
  });

  it('gives a multiSelect "holds any of" on the GIN index', () => {
    const any = render(fields['custom.tags'].conditions!.in!(['a', 'b']));
    expect(any.sql).toBe(`("notes"."custom"->'tags') ?| array[$1, $2]::text[]`);
    expect(any.params).toEqual(['a', 'b']);
  });

  it('refuses a key that is not a slug (it is inlined in SQL)', () => {
    expect(() =>
      customFilterFields([field("x'; drop", 'text')], notes.custom),
    ).toThrow('Invalid custom field key');
  });
});

describe('coerceImported', () => {
  it('turns file text into typed values, and leaves what it cannot convert', () => {
    const number = { type: 'number', options: null } as const;
    const boolean = { type: 'boolean', options: null } as const;
    const date = { type: 'date', options: null } as const;
    const multiSelect: Pick<CustomFieldDefinition, 'type' | 'options'> = {
      type: 'multiSelect',
      options: [
        { value: 'a', label: 'Alpha' },
        { value: 'b', label: 'Beta' },
      ],
    };
    const select = { ...multiSelect, type: 'select' as const };
    const text = { type: 'text', options: null } as const;
    expect(coerceImported(number, ' 12.5 ')).toBe(12.5);
    expect(coerceImported(number, 'lots')).toBe('lots');
    expect(coerceImported(boolean, 'Yes')).toBe(true);
    expect(coerceImported(boolean, '0')).toBe(false);
    expect(coerceImported(date, '2026-01-02T00:00:00.000Z')).toBe('2026-01-02');
    expect(coerceImported(multiSelect, '["a","b"]')).toEqual(['a', 'b']);
    expect(coerceImported(multiSelect, 'a, b')).toEqual(['a', 'b']);
    expect(coerceImported(text, '')).toBeUndefined();
    // A choice by its label (whatever the case), as the dropdown shows it.
    expect(coerceImported(select, 'Beta')).toBe('b');
    expect(coerceImported(select, 'ALPHA')).toBe('a');
    expect(coerceImported(select, 'gamma')).toBe('gamma');
    expect(coerceImported(multiSelect, 'Alpha, b')).toEqual(['a', 'b']);
    expect(coerceImported(multiSelect, ['Beta'])).toEqual(['b']);
  });
});
