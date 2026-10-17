import { randomBytes, randomUUID } from 'node:crypto';
import { text, pgTable, uuid } from 'drizzle-orm/pg-core';
import { openCursor, sealCursor, useCursorKeys } from './cursor-seal.js';
import { listQuery } from './list-query.js';
import { decodeCursor, encodeCursor } from './list-sort.js';

const key = () => randomBytes(32).toString('base64');

describe('sealed cursors', () => {
  const [older, newer] = [key(), key()];
  beforeEach(() => useCursorKeys([older]));

  it('opens what it sealed, for the same context only', () => {
    const sealed = sealCursor('{"v":["Secret salary"]}', 'sort:salary');
    expect(sealed).not.toContain('Secret');
    expect(() =>
      JSON.parse(Buffer.from(sealed, 'base64url').toString()),
    ).toThrow();
    expect(openCursor(sealed, 'sort:salary')).toBe('{"v":["Secret salary"]}');
    expect(openCursor(sealed, 'sort:-salary')).toBeUndefined();
    // A fresh IV each time: the same value never gives the same cursor.
    expect(sealCursor('x', 'c')).not.toBe(sealCursor('x', 'c'));
  });

  it('refuses a changed, foreign or malformed cursor', () => {
    const sealed = sealCursor('{"v":[1]}', 'c');
    const [id, body] = sealed.split('.');
    const bytes = Buffer.from(body, 'base64url');
    for (const index of [0, 13, bytes.length - 1]) {
      const flipped = Buffer.from(bytes);
      flipped[index] ^= 1;
      expect(
        openCursor(`${id}.${flipped.toString('base64url')}`, 'c'),
      ).toBeUndefined();
    }
    for (const cursor of [
      '',
      'garbage',
      `${id}.`,
      `${id}.${body}.extra`,
      `${id}.${bytes.subarray(0, 20).toString('base64url')}`,
      `other.${body}`,
      Buffer.from('{"s":"c","v":[1]}').toString('base64url'),
    ]) {
      expect(openCursor(cursor, 'c'), cursor).toBeUndefined();
    }
    // Sealed under a key this server doesn't have.
    useCursorKeys([key()]);
    expect(openCursor(sealed, 'c')).toBeUndefined();
  });

  it('opens cursors of an older key after a rotation, and seals with the newest', () => {
    const before = sealCursor('old', 'c');
    useCursorKeys([newer, older]);
    expect(openCursor(before, 'c')).toBe('old');
    const after = sealCursor('new', 'c');
    expect(after.split('.')[0]).not.toBe(before.split('.')[0]);
    // The older key dropped: its cursors no longer open.
    useCursorKeys([newer]);
    expect(openCursor(before, 'c')).toBeUndefined();
    expect(openCursor(after, 'c')).toBe('new');
  });

  it('takes only keys long enough, at least one', () => {
    expect(() => useCursorKeys([])).toThrow(/at least one key/);
    expect(() => useCursorKeys(['short'])).toThrow(/at least 32/);
    // Spaces around the comma-separated keys are not part of them.
    useCursorKeys([` ${older} `]);
    const sealed = sealCursor('x', 'c');
    useCursorKeys([older]);
    expect(openCursor(sealed, 'c')).toBe('x');
  });
});

describe('a sorted list cursor', () => {
  const things = pgTable('things', {
    id: uuid('id').primaryKey(),
    title: text('title').notNull(),
    salary: text('salary'),
  });
  const LIST = listQuery({
    title: { column: things.title, type: 'string', ops: [], sortable: true },
    salary: { column: things.salary, type: 'string', ops: [], sortable: true },
  });
  const sortOf = (sort: string) => LIST.parse({ sort }).sort!;

  it('carries the sort values sealed, for its sort only', () => {
    useCursorKeys([key()]);
    const id = randomUUID();
    const cursor = encodeCursor(sortOf('salary,title'), {
      id,
      salary: '123456',
      title: 'Hidden title',
    });
    expect(cursor).not.toMatch(/123456|Hidden/);
    expect(
      Buffer.from(cursor.split('.')[1], 'base64url').toString('latin1'),
    ).not.toMatch(/123456|Hidden/);
    expect(decodeCursor(cursor, sortOf('salary,title'))).toEqual({
      after: ['123456', 'Hidden title'],
      id,
    });
    for (const other of ['-salary,title', 'salary', 'title,salary']) {
      expect(decodeCursor(cursor, sortOf(other)), other).toBeUndefined();
    }
    // Through the list's own validation: the same 400 as any bad cursor.
    expect(
      LIST.schema.safeParse({ sort: 'salary,title', cursor }).success,
    ).toBe(true);
    expect(LIST.schema.safeParse({ sort: 'title', cursor }).success).toBe(
      false,
    );
  });
});
