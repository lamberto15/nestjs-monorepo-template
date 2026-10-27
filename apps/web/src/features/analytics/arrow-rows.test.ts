import {
  Binary,
  Bool,
  DateMillisecond,
  Field,
  Float64,
  Int64,
  List,
  Map_,
  Struct,
  Table,
  Utf8,
  vectorFromArray,
} from 'apache-arrow';
import { describe, expect, it } from 'vitest';
import { arrowTableRows } from './arrow-rows';

describe('Arrow result materialization', () => {
  it('preserves primitive values, nulls, and row and column order', () => {
    const table = new Table({
      name: vectorFromArray(['first', null, 'last'], new Utf8()),
      amount: vectorFromArray([12, null, 24], new Float64()),
      enabled: vectorFromArray([true, false, null], new Bool()),
    });
    const result = arrowTableRows(table);
    expect(result).toEqual({
      columns: ['name', 'amount', 'enabled'],
      rows: [
        { name: 'first', amount: 12, enabled: true },
        { name: null, amount: null, enabled: false },
        { name: 'last', amount: 24, enabled: null },
      ],
    });
    expect(structuredClone(result)).toEqual(result);
  });

  it('retains own columns that collide with object and Arrow row properties', () => {
    const names = ['__proto__', 'constructor', 'toString', 'toJSON', 'normal'];
    const table = new Table(
      Object.fromEntries(
        names.map((name) => [
          name,
          vectorFromArray([`value:${name}`], new Utf8()),
        ]),
      ),
    );
    const result = arrowTableRows(table);
    expect(result.columns).toEqual(names);
    const row = result.rows[0]!;
    for (const name of names) {
      expect(Object.hasOwn(row, name)).toBe(true);
      expect(row[name]).toBe(`value:${name}`);
    }
    expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
    expect(structuredClone(result)).toEqual(result);
  });

  it('materializes nested structs and lists recursively, including colliding nested fields', () => {
    const itemType = new Struct([
      new Field('__proto__', new Utf8(), true),
      new Field('constructor', new Utf8(), true),
      new Field('tags', new List(new Field('item', new Utf8(), true)), true),
    ]);
    const item = Object.fromEntries([
      ['__proto__', 'safe value'],
      ['constructor', 'nested constructor'],
      ['tags', ['one', null, 'two']],
    ]);
    const table = new Table({
      details: vectorFromArray([item, null], itemType),
      items: vectorFromArray(
        [[item], []],
        new List(new Field('item', itemType, true)),
      ),
    });
    const result = arrowTableRows(table);
    expect(result.rows).toEqual([
      { details: item, items: [item] },
      { details: null, items: [] },
    ]);
    expect(Object.hasOwn(result.rows[0]!.details as object, '__proto__')).toBe(
      true,
    );
    expect(structuredClone(result)).toEqual(result);
  });

  it('keeps binary, bigint, and date values in their native Arrow forms', () => {
    const bytes = new Uint8Array([0, 127, 255]);
    const integer = 9_007_199_254_740_993n;
    const date = new Date('2026-10-25T12:00:00Z');
    const table = new Table({
      bytes: vectorFromArray([bytes], new Binary()),
      integer: vectorFromArray([integer], new Int64()),
      date: vectorFromArray([date], new DateMillisecond()),
    });
    const result = arrowTableRows(table);
    expect(result.rows).toEqual([{ bytes, integer, date: date.getTime() }]);
    const cloned = structuredClone(result);
    // Node's Arrow binary buffers clone to Uint8Array, as browser buffers do.
    expect(ArrayBuffer.isView(cloned.rows[0]!.bytes)).toBe(true);
    expect(Array.from(cloned.rows[0]!.bytes as Uint8Array)).toEqual([...bytes]);
    expect(cloned.rows[0]!.integer).toBe(integer);
    expect(cloned.rows[0]!.date).toBe(date.getTime());
  });

  it('materializes Arrow maps and nested map values as cloneable Maps', () => {
    const valueType = new Struct([new Field('label', new Utf8(), true)]);
    const mapType = new Map_<Utf8, typeof valueType>(
      new Field(
        'entries',
        new Struct<{ key: Utf8; value: typeof valueType }>([
          new Field('key', new Utf8(), false),
          new Field('value', valueType, true),
        ]),
        false,
      ),
    );
    const map = new Map([
      ['__proto__', { label: 'safe' }],
      ['other', { label: 'value' }],
    ]);
    const table = new Table({ properties: vectorFromArray([map], mapType) });
    const result = arrowTableRows(table);
    expect(result.rows).toEqual([{ properties: map }]);
    expect(structuredClone(result)).toEqual(result);
  });

  it('retains the schema for an empty query result', () => {
    const table = new Table({ name: vectorFromArray([], new Utf8()) });
    expect(arrowTableRows(table)).toEqual({ columns: ['name'], rows: [] });
  });
});
