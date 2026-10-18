import type { TFunction } from 'i18next';
import { describe, expect, it } from 'vitest';
import {
  customFieldColumns,
  customValue,
  fieldLabel,
  refColumns,
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
      ref: 'tag',
    },
    {
      name: 'ownerId',
      type: 'string',
      operators: ['eq'],
      sortable: false,
      custom: false,
      ref: 'principal',
    },
    {
      name: 'invoiceId',
      type: 'uuid',
      operators: ['eq'],
      sortable: false,
      custom: false,
      ref: 'Invoice',
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
  select: ['title', 'ownerId', 'invoiceId'],
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

describe('refColumns', () => {
  const refs = {
    tag: { options: [] },
    principal: { options: [{ label: 'Ada Lovelace', value: 'user:1' }] },
  };

  it('adds a column per ref field with a source, filter-only when not selectable', () => {
    const columns = refColumns<Record<string, unknown>>(description, refs, t);
    // A record's subject (Invoice) has no source here.
    expect(columns.map((c) => c.id)).toEqual(['tag', 'ownerId']);
    expect(columns[0]).toMatchObject({
      id: 'tag',
      enableHiding: false,
      meta: { label: 'list.fields.tag' },
    });
    expect(columns[1]).toMatchObject({
      id: 'ownerId',
      meta: { label: 'list.fields.ownerId' },
    });
    expect(columns[1]?.enableHiding).toBeUndefined();
  });

  it('shows names, and the value itself when its name is unknown', () => {
    const [, owner] = refColumns<Record<string, unknown>>(
      description,
      refs,
      t,
    ) as unknown as { accessorFn: (row: unknown) => string }[];
    expect(owner?.accessorFn({ ownerId: 'user:1' })).toBe('Ada Lovelace');
    expect(owner?.accessorFn({ ownerId: 'client:9' })).toBe('client:9');
    expect(owner?.accessorFn({ ownerId: null })).toBe('');
  });

  it('labels a field by its name when no translation has it', () => {
    expect(fieldLabel('ownerId')).toBe('Owner');
    expect(fieldLabel('approvedById')).toBe('Approved by');
    expect(fieldLabel('tag')).toBe('Tag');
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
