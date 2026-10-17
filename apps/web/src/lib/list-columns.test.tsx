import type { TFunction } from 'i18next';
import { describe, expect, it } from 'vitest';
import {
  customFieldColumns,
  customValue,
  tagFilterColumns,
} from '@/lib/list-columns';
import type { ListDescription } from '@/lib/list-query';

// The keys, so what is asked of `t` is visible.
const t = ((key: string) => key) as unknown as TFunction;

const description = {
  fields: [
    {
      name: 'title',
      type: 'string',
      operators: [],
      sortable: true,
      custom: false,
    },
    {
      name: 'tag',
      type: 'uuid',
      operators: ['eq', 'in'],
      sortable: false,
      custom: false,
    },
    {
      name: 'custom.region',
      type: 'enum',
      options: ['eu', 'us'],
      operators: ['eq'],
      sortable: true,
      custom: true,
      label: 'Region',
    },
    {
      name: 'custom.due',
      type: 'date',
      operators: [],
      sortable: true,
      custom: true,
    },
  ],
} as unknown as ListDescription;

describe('customFieldColumns', () => {
  it('makes one column per custom field, reading row.custom[key]', () => {
    const columns = customFieldColumns<{ custom?: Record<string, unknown> }>(
      description,
      'en',
      t,
    );
    expect(columns.map((c) => c.id)).toEqual(['custom.region', 'custom.due']);
    const [region] = columns as unknown as {
      accessorFn: (row: unknown) => string;
      meta: { label: string };
    }[];
    expect(region?.meta.label).toBe('Region');
    expect(region?.accessorFn({ custom: { region: 'eu' } })).toBe('eu');
    expect(region?.accessorFn({})).toBe('');
  });
});

describe('tagFilterColumns', () => {
  it('adds a never-shown column for the tag field only', () => {
    const columns = tagFilterColumns(description, 'Tag');
    expect(columns).toHaveLength(1);
    expect(columns[0]).toMatchObject({
      id: 'tag',
      enableHiding: false,
      meta: { label: 'Tag' },
    });
  });
});

describe('customValue', () => {
  it('shows booleans, numbers, lists and dates in the language', () => {
    expect(customValue(true, 'boolean', 'en', t)).toBe('list.yes');
    expect(customValue(false, 'boolean', 'en', t)).toBe('list.no');
    expect(customValue(1234.5, 'number', 'de', t)).toBe('1.234,5');
    expect(customValue(['a', 'b'], 'enum', 'en', t)).toBe('a, b');
    expect(customValue(null, 'string', 'en', t)).toBe('');
    // A calendar date keeps its day whatever the time zone.
    expect(customValue('2026-02-01', 'date', 'en', t)).toBe('Feb 1, 2026');
  });
});
