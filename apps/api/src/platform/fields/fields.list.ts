import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { type AnyField, type Fields, referencedSubject } from './field.js';

/**
 * The list's filters and sorts of each field (core/http/list-query.ts's
 * `listQuery` entries), spread into a record's list declaration. A money
 * field filters by its currency; JSON fields don't filter. Apart from
 * fields.ts: list-query.ts reaches Nest, which the tables must not.
 */
const ENTRIES: Record<
  AnyField['kind'],
  ((f: AnyField) => { type: string; ops: string[]; sortable?: boolean }) | null
> = {
  string: () => ({
    type: 'string',
    ops: ['eq', 'contains', 'startsWith'],
    sortable: true,
  }),
  text: () => ({ type: 'string', ops: ['contains'] }),
  int: () => ({
    type: 'number',
    ops: ['eq', 'gt', 'gte', 'lt', 'lte', 'between'],
    sortable: true,
  }),
  decimal: () => ({
    type: 'number',
    ops: ['gt', 'gte', 'lt', 'lte'],
    sortable: true,
  }),
  money: () => ({ type: 'string', ops: ['eq', 'in'] }),
  bool: () => ({ type: 'boolean', ops: ['eq'], sortable: true }),
  date: () => ({
    type: 'date',
    ops: ['eq', 'gt', 'gte', 'lt', 'lte', 'between'],
    sortable: true,
  }),
  datetime: () => ({
    type: 'datetime',
    ops: ['gt', 'gte', 'lt', 'lte', 'between'],
    sortable: true,
  }),
  enum: () => ({
    type: 'enum',
    ops: ['eq', 'ne', 'in', 'notIn'],
    sortable: true,
  }),
  json: null,
  ref: () => ({ type: 'uuid', ops: ['eq', 'in'] }),
};

/** The subject a reference field's values are ids of (the `ref` of its list entry). */
function refOf(name: string, f: AnyField) {
  const subject = referencedSubject(f);
  if (!subject) {
    throw new Error(
      `${name}: the table it references isn't a record's: name its subject, field.ref(() => table, 'Subject').`,
    );
  }
  return subject;
}

/** The fields' list entries: `listQuery({ ...fieldList(F, table), ownerId: …, createdAt: … })`. */
export function fieldList(fields: Fields, table: Record<string, AnyPgColumn>) {
  const entries: Record<string, Record<string, unknown>> = {};
  for (const [name, f] of Object.entries(fields)) {
    const entry = ENTRIES[f.kind]?.(f);
    if (!entry) continue;
    const key = f.kind === 'money' ? `${name}Currency` : name;
    entries[key] = {
      column: table[key],
      ...entry,
      // The currency is part of the money field's value: its permission covers it.
      ...(f.kind === 'money' && { reads: [name] }),
      ops: f.options.optional
        ? [...new Set([...entry.ops, 'isNull'])]
        : entry.ops,
      ...(f.kind === 'enum' && { values: f.options.values }),
      // A reference's values are ids of the records it points at: clients show a picker of them.
      ...(f.kind === 'ref' && { ref: refOf(name, f) }),
    };
  }
  // The list's entry types are checked where the record declares its list.
  return entries as Record<string, never>;
}
