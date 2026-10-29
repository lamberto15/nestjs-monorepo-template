import { describe, expect, it } from 'vitest';
// The contract: the API's own evaluator, the authority this file mirrors.
import * as server from '../../../../api/src/platform/forms/form-rules.ts';
import {
  evaluate,
  type FormCondition,
  OPERATORS_BY_TYPE,
  walkForm,
} from './rules';

/** A small seeded generator: the same cases on every run. */
function random(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

const VALUES: Record<string, readonly unknown[]> = {
  text: ['', 'a', 'b', 'Ada'],
  integer: [-1, 0, 3, 10],
  date: ['2026-01-01', '2026-06-30', '2027-01-01'],
  checkbox: [true, false],
  select: ['a', 'b', 'c'],
  multiSelect: [[], ['a'], ['a', 'b'], ['c']],
};
const FIELDS = Object.keys(VALUES).map((type) => ({ key: `f_${type}`, type }));

function condition(next: () => number, depth = 0): FormCondition {
  const pick = <T>(items: readonly T[]) =>
    items[Math.floor(next() * items.length)]!;
  const roll = next();
  if (depth < 3 && roll < 0.15) {
    return { all: [condition(next, depth + 1), condition(next, depth + 1)] };
  }
  if (depth < 3 && roll < 0.3) {
    return { any: [condition(next, depth + 1), condition(next, depth + 1)] };
  }
  if (depth < 3 && roll < 0.4) return { not: condition(next, depth + 1) };
  const field = pick(FIELDS);
  const op = pick(OPERATORS_BY_TYPE[field.type]!);
  const scalar = () => {
    const value = pick(VALUES[field.type]!);
    return Array.isArray(value) ? 'a' : (value as string | number | boolean);
  };
  if (op === 'isEmpty') return { field: field.key, op };
  if (op === 'in') {
    return {
      field: field.key,
      op,
      value: [scalar(), scalar()] as (string | number)[],
    };
  }
  return { field: field.key, op, value: scalar() } as FormCondition;
}

function answers(next: () => number): Record<string, unknown> {
  return Object.fromEntries(
    FIELDS.filter(() => next() < 0.8).map((field) => {
      const values = VALUES[field.type]!;
      return [field.key, values[Math.floor(next() * values.length)]];
    }),
  );
}

describe('form conditions (the web mirror of the API)', () => {
  it('evaluates as the server does on a thousand generated cases', () => {
    const next = random(547);
    for (let i = 0; i < 1_000; i++) {
      const rule = condition(next);
      const given = answers(next);
      expect(evaluate(rule, given), JSON.stringify({ rule, given })).toBe(
        server.evaluate(rule as server.RuleCondition, given),
      );
    }
  });

  it('decides what shows and what is required as the server does', () => {
    const next = random(548);
    for (let i = 0; i < 200; i++) {
      const sections = [0, 1].map((s) => ({
        key: `s${s}`,
        visibleWhen: next() < 0.3 ? condition(next) : undefined,
        fields: FIELDS.map((field) => ({
          ...field,
          key: `${field.key}_${s}`,
          visibleWhen: next() < 0.5 ? condition(next) : undefined,
          requiredWhen: next() < 0.3 ? condition(next) : undefined,
        })),
      }));
      const given = answers(next);
      const decide = (walk: typeof walkForm) => {
        const required: string[] = [];
        const { visible } = walk(sections, (field, needed) => {
          if (needed) required.push(field.key);
          return given[field.key.slice(0, -2)];
        });
        return { visible: [...visible], required };
      };
      expect(decide(walkForm)).toEqual(
        decide(server.walkForm as unknown as typeof walkForm),
      );
    }
  });

  it('reads a missing answer as empty, and compares only values of one type', () => {
    expect(evaluate({ field: 'a', op: 'isEmpty' }, {})).toBe(true);
    expect(evaluate({ field: 'a', op: 'ne', value: 'x' }, {})).toBe(true);
    expect(evaluate({ field: 'a', op: 'gt', value: 1 }, {})).toBe(false);
    expect(evaluate({ field: 'a', op: 'gt', value: 1 }, { a: '2' })).toBe(
      false,
    );
    expect(
      evaluate(
        { field: 'd', op: 'lt', value: '2026-02-01' },
        { d: '2026-01-31' },
      ),
    ).toBe(true);
    expect(
      evaluate({ field: 'm', op: 'contains', value: 'b' }, { m: ['a', 'b'] }),
    ).toBe(true);
    expect(server.OPERATORS_BY_TYPE).toEqual(OPERATORS_BY_TYPE);
  });
});
