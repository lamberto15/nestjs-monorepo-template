import { CurrencyMismatchError, Money } from '../money/money.js';
import {
  type Decimal,
  DECIMAL_PATTERN,
  divideRounded,
  formatDecimal,
  pow10,
  rescale,
  toDecimal,
} from '../money/decimal.js';

/**
 * A small, safe expression language: what computed fields
 * (platform/records/record-computed.ts) are written in, and what any other
 * declared or tenant-written rule can evaluate (an automation's condition).
 *
 * `quantity * unitPrice`, `if(dueOn < paidOn, 'late', 'on time')`,
 * `daysBetween(startOn, endOn) + 1`, `concat(title, ': ', coalesce(body, ''))`
 *
 * - Compiled once against the names it may read and their types
 *   (`compileExpression(source, variables)`): an unknown name or function,
 *   a type error or a syntax error is an ExpressionError then, never at run
 *   time. No `eval`, `Function` or `vm`: a hand-written parser builds a tree
 *   of the allowlisted operators and functions below, and nothing else runs.
 * - Bounded: the source's length, the number of nodes and the nesting depth
 *   are capped (EXPRESSION_LIMITS); there are no loops, so evaluating is
 *   linear in the nodes. Numbers, strings and dates are capped too (an
 *   `out_of_range` error rather than an unbounded bigint or string).
 * - Deterministic and side-effect free: no clock (`now()`), no randomness,
 *   no locale, no I/O. The same values give the same result, so a value
 *   computed on read keeps an ETag stable.
 * - Typed: `int`, `decimal` (exact, bigint: never a float), `money` (Money:
 *   two currencies never mix), `string`, `bool`, `date` (`2026-01-31`),
 *   `datetime`. A null input makes arithmetic, comparisons and functions
 *   null (`coalesce()` and `== null` test for it); `and`, `or`, `not` and
 *   `if()` read null as false.
 *
 * Custom code: no installed package evaluates expressions, and the ones that
 * do (expression evaluators, JSON logic) either run JavaScript, lack exact
 * decimals and money, or don't type-check before running.
 */

export type ExpressionType =
  'int' | 'decimal' | 'money' | 'string' | 'bool' | 'date' | 'datetime';

/** The caps on an expression and on what it computes. */
export const EXPRESSION_LIMITS = {
  /** Characters of source. */
  source: 2000,
  /** Literals, names, operators and calls. */
  nodes: 200,
  /** Nesting: parentheses, calls, unary operators. */
  depth: 24,
  /** Characters of a string literal, and of a string computed. */
  text: 10_000,
  /** Whole digits of a number (beyond: `out_of_range`). */
  digits: 30,
  /** Decimals kept (a product's are rounded half-up beyond). */
  scale: 20,
  /** Decimals of a division's result. */
  divisionScale: 10,
} as const;

export type ExpressionErrorCode =
  | 'syntax'
  | 'too_long'
  | 'too_complex'
  | 'too_deep'
  | 'unknown_name'
  | 'unknown_function'
  | 'type'
  | 'division_by_zero'
  | 'currency_mismatch'
  | 'out_of_range'
  | 'invalid_value';

/** An expression that can't compile (`position`: where in the source), or a value it can't compute. */
export class ExpressionError extends Error {
  constructor(
    readonly code: ExpressionErrorCode,
    message: string,
    readonly position?: number,
  ) {
    super(position === undefined ? message : `${message} (at ${position})`);
    this.name = 'ExpressionError';
  }
}

/** A compiled expression. */
export interface Expression {
  readonly source: string;
  /** The type of its result (null aside). */
  readonly type: ExpressionType;
  /** The names it reads, sorted: what a caller must be allowed to see. */
  readonly reads: readonly string[];
  /**
   * Its value for `values` (by name, as the API shows them: a decimal's
   * string, money's `{ amount, currency }`, a datetime's Date or ISO
   * string; a missing one is null), as the API shows its type, or null.
   * Throws an ExpressionError when it can't be computed (a division by
   * zero, two currencies, a value out of range or not of its type).
   */
  evaluate(values: Readonly<Record<string, unknown>>): unknown;
}

// Values while evaluating: numbers as decimals, dates as their string, datetimes as epoch milliseconds.
type Value = Decimal | Money | string | boolean | number | null;
type Variables = ReadonlyMap<string, Value>;
type StaticType = ExpressionType | 'null';
interface Typed {
  type: StaticType;
  run: (variables: Variables) => Value;
  /** An integer literal's value (round()'s places). */
  literal?: number;
}

const fail = (code: ExpressionErrorCode, message: string, at?: number) => {
  throw new ExpressionError(code, message, at);
};

// --- Numbers, money, dates ---------------------------------------------

const isNumber = (type: StaticType) => type === 'int' || type === 'decimal';

/** Kept within the caps: a long fraction rounded half-up, too many digits refused. */
function bounded(value: Decimal): Decimal {
  const d =
    value.scale > EXPRESSION_LIMITS.scale
      ? {
          units: rescale(value, EXPRESSION_LIMITS.scale),
          scale: EXPRESSION_LIMITS.scale,
        }
      : value;
  const magnitude = d.units < 0n ? -d.units : d.units;
  if (magnitude >= pow10(EXPRESSION_LIMITS.digits + d.scale)) {
    fail('out_of_range', 'A number is out of range');
  }
  return d;
}

function boundedMoney(value: Money): Money {
  const magnitude = value.minor < 0n ? -value.minor : value.minor;
  if (magnitude >= pow10(EXPRESSION_LIMITS.digits)) {
    fail('out_of_range', 'An amount is out of range');
  }
  return value;
}

const aligned = (a: Decimal, b: Decimal) => {
  const scale = Math.max(a.scale, b.scale);
  return {
    scale,
    a: a.units * pow10(scale - a.scale),
    b: b.units * pow10(scale - b.scale),
  };
};
const add = (a: Decimal, b: Decimal, sign: 1n | -1n): Decimal => {
  const x = aligned(a, b);
  return bounded({ units: x.a + sign * x.b, scale: x.scale });
};
const compareDecimals = (a: Decimal, b: Decimal) => {
  const x = aligned(a, b);
  return x.a < x.b ? -1 : x.a > x.b ? 1 : 0;
};
/** Without trailing zeros (a division's `2.0000000000` is `2`). */
const trimmed = ({ units, scale }: Decimal): Decimal => {
  while (scale > 0 && units % 10n === 0n) {
    units /= 10n;
    scale -= 1;
  }
  return { units, scale };
};
function divide(a: Decimal, b: Decimal): Decimal {
  if (b.units === 0n) fail('division_by_zero', 'Division by zero');
  const scale = EXPRESSION_LIMITS.divisionScale;
  // a / b = a.units·10^b.scale / (b.units·10^a.scale), at `scale` decimals.
  const units = divideRounded(
    a.units * pow10(b.scale + scale),
    b.units * pow10(a.scale),
  );
  return bounded(trimmed({ units, scale }));
}
const decimalText = (d: Decimal) => formatDecimal(d.units, d.scale);

const sameCurrency = (a: Money, b: Money) => {
  if (a.currency !== b.currency) {
    fail(
      'currency_mismatch',
      `Currency mismatch: ${a.currency} and ${b.currency}`,
    );
  }
};

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATETIME =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/;
const DAY = 86_400_000;

/** A calendar day as days since 1970-01-01, or undefined when it isn't one. */
function dayNumber(value: string): number | undefined {
  const match = DATE.exec(value);
  if (!match) return undefined;
  const [year, month, day] = match.slice(1).map(Number) as [
    number,
    number,
    number,
  ];
  const time = Date.UTC(year, month - 1, day);
  const back = new Date(time);
  // Date.UTC() maps years 0-99 to 1900-1999 and rolls 02-31 over: refuse both.
  if (
    back.getUTCFullYear() !== year ||
    back.getUTCMonth() !== month - 1 ||
    back.getUTCDate() !== day
  ) {
    return undefined;
  }
  return time / DAY;
}
function dateOfDay(days: number): string {
  const date = new Date(days * DAY);
  const year = date.getUTCFullYear();
  if (!Number.isFinite(days) || year < 1000 || year > 9999) {
    fail('out_of_range', 'A date is out of range');
  }
  return date.toISOString().slice(0, 10);
}
function datetimeOf(value: string): number | undefined {
  if (!DATETIME.test(value)) return undefined;
  const time = Date.parse(value);
  return Number.isNaN(time) ? undefined : time;
}

// --- Values in and out -------------------------------------------------

const invalid = (name: string, type: ExpressionType): never =>
  fail('invalid_value', `${name} is not a ${type}`);

/** A value as the API shows it, as the evaluator works with it. */
function valueOf(name: string, type: ExpressionType, raw: unknown): Value {
  if (raw === null || raw === undefined) return null;
  switch (type) {
    case 'int':
    case 'decimal': {
      if (
        typeof raw !== 'bigint' &&
        typeof raw !== 'number' &&
        (typeof raw !== 'string' || !DECIMAL_PATTERN.test(raw))
      ) {
        return invalid(name, type);
      }
      try {
        const value = bounded(toDecimal(raw));
        return type === 'int' && value.scale > 0 ? invalid(name, type) : value;
      } catch (error) {
        if (error instanceof ExpressionError) throw error;
        return invalid(name, type);
      }
    }
    case 'money': {
      if (raw instanceof Money) return raw;
      const money = raw as { amount?: unknown; currency?: unknown };
      if (
        typeof money.amount !== 'string' ||
        typeof money.currency !== 'string'
      ) {
        return invalid(name, type);
      }
      try {
        return boundedMoney(Money.of(money.amount, money.currency));
      } catch (error) {
        if (error instanceof ExpressionError) throw error;
        return invalid(name, type);
      }
    }
    case 'string':
      return typeof raw === 'string' ? raw : invalid(name, type);
    case 'bool':
      return typeof raw === 'boolean' ? raw : invalid(name, type);
    case 'date':
      return typeof raw === 'string' && dayNumber(raw) !== undefined
        ? raw
        : invalid(name, type);
    case 'datetime': {
      const time =
        raw instanceof Date
          ? raw.getTime()
          : typeof raw === 'string'
            ? datetimeOf(raw)
            : undefined;
      return time === undefined || Number.isNaN(time)
        ? invalid(name, type)
        : time;
    }
  }
}

/** A result as the API shows its type: an int a number, a decimal its string, money `{ amount, currency }`, a datetime its ISO string. */
function output(type: ExpressionType, value: Value): unknown {
  if (value === null) return null;
  switch (type) {
    case 'int': {
      const n = Number((value as Decimal).units);
      if (!Number.isSafeInteger(n)) {
        fail('out_of_range', 'A whole number is out of range');
      }
      return n;
    }
    case 'decimal':
      return decimalText(value as Decimal);
    case 'money':
      return (value as Money).toJSON();
    case 'datetime':
      return new Date(value as number).toISOString();
    default:
      return value;
  }
}

/** `text(x)`: a value as a string. */
function textOf(type: StaticType, value: Value): string {
  switch (type) {
    case 'int':
    case 'decimal':
      return decimalText(value as Decimal);
    case 'money': {
      const { amount, currency } = (value as Money).toJSON();
      return `${amount} ${currency}`;
    }
    case 'datetime':
      return new Date(value as number).toISOString();
    default:
      return String(value as string | boolean);
  }
}

/** Characters as code points (`length('é')` is 1, an emoji 1 or more). */
function codePoints(value: string) {
  let count = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    // A high surrogate starts a pair: one character.
    if (code < 0xd800 || code > 0xdbff) count++;
  }
  return count;
}

const boundedText = (value: string) => {
  if (value.length > EXPRESSION_LIMITS.text) {
    fail('out_of_range', 'A string is too long');
  }
  return value;
};

// --- Operators ---------------------------------------------------------

/** The run of an operation on values, null when any is null. */
const strict =
  (args: Typed[], apply: (values: Value[]) => Value) =>
  (variables: Variables): Value => {
    const values = args.map((arg) => arg.run(variables));
    return values.includes(null) ? null : apply(values);
  };

const typeError = (message: string, at: number): never =>
  fail('type', message, at);

function arithmetic(op: string, left: Typed, right: Typed, at: number): Typed {
  const l = left.type;
  const r = right.type;
  const both = [left, right];
  const bothInt = l === 'int' && r === 'int';
  if (isNumber(l) && isNumber(r)) {
    if (op === '/') {
      return {
        type: 'decimal',
        run: strict(both, ([a, b]) => divide(a as Decimal, b as Decimal)),
      };
    }
    return {
      type: bothInt ? 'int' : 'decimal',
      run: strict(both, ([a, b]) => {
        const x = a as Decimal;
        const y = b as Decimal;
        if (op === '*') {
          return bounded({
            units: x.units * y.units,
            scale: x.scale + y.scale,
          });
        }
        return add(x, y, op === '+' ? 1n : -1n);
      }),
    };
  }
  if (l === 'money' && r === 'money') {
    if (op === '+' || op === '-') {
      return {
        type: 'money',
        run: strict(both, ([a, b]) => {
          sameCurrency(a as Money, b as Money);
          return boundedMoney(
            op === '+'
              ? (a as Money).plus(b as Money)
              : (a as Money).minus(b as Money),
          );
        }),
      };
    }
    if (op === '/') {
      // A ratio: what share one amount is of another.
      return {
        type: 'decimal',
        run: strict(both, ([a, b]) => {
          sameCurrency(a as Money, b as Money);
          return divide(
            { units: (a as Money).minor, scale: 0 },
            { units: (b as Money).minor, scale: 0 },
          );
        }),
      };
    }
  }
  if (
    (op === '*' &&
      ((l === 'money' && isNumber(r)) || (isNumber(l) && r === 'money'))) ||
    (op === '/' && l === 'money' && isNumber(r))
  ) {
    const moneyFirst = l === 'money';
    return {
      type: 'money',
      run: strict(both, ([a, b]) => {
        const money = (moneyFirst ? a : b) as Money;
        const factor = (moneyFirst ? b : a) as Decimal;
        if (op === '/') {
          if (factor.units === 0n) fail('division_by_zero', 'Division by zero');
          return boundedMoney(money.dividedBy(decimalText(factor)));
        }
        return boundedMoney(money.times(decimalText(factor)));
      }),
    };
  }
  return typeError(`${l} ${op} ${r} is not an operation`, at);
}

/** The order of two values of one type, for comparisons, min() and max(). */
function order(type: StaticType, a: Value, b: Value): number {
  if (isNumber(type)) return compareDecimals(a as Decimal, b as Decimal);
  if (type === 'money') {
    sameCurrency(a as Money, b as Money);
    return (a as Money).compare(b as Money);
  }
  if (type === 'date') {
    return dayNumber(a as string)! - dayNumber(b as string)!;
  }
  // Strings by code unit (no locale), datetimes by their time.
  return a! < b! ? -1 : a! > b! ? 1 : 0;
}

/** The one type values of `a` and `b` share (an int is a decimal; null is any), or undefined. */
function common(a: StaticType, b: StaticType): StaticType | undefined {
  if (a === b) return a;
  if (a === 'null') return b;
  if (b === 'null') return a;
  if (isNumber(a) && isNumber(b)) return 'decimal';
  return undefined;
}

const ORDERED: readonly StaticType[] = [
  'int',
  'decimal',
  'money',
  'string',
  'date',
  'datetime',
];

function comparison(op: string, left: Typed, right: Typed, at: number): Typed {
  const type = common(left.type, right.type);
  if (op === '==' || op === '!=') {
    if (!type) {
      return typeError(
        `${left.type} ${op} ${right.type} compares two types`,
        at,
      );
    }
    const equal = (variables: Variables) => {
      const a = left.run(variables);
      const b = right.run(variables);
      if (a === null || b === null) return a === b;
      if (type === 'money' && (a as Money).currency !== (b as Money).currency) {
        return false;
      }
      return order(type, a, b) === 0;
    };
    return {
      type: 'bool',
      run: op === '==' ? equal : (variables) => !equal(variables),
    };
  }
  if (!type || type === 'null' || !ORDERED.includes(type)) {
    return typeError(`${left.type} ${op} ${right.type} can't be ordered`, at);
  }
  return {
    type: 'bool',
    run: strict([left, right], ([a, b]) => {
      const c = order(type, a!, b!);
      return op === '<'
        ? c < 0
        : op === '<='
          ? c <= 0
          : op === '>'
            ? c > 0
            : c >= 0;
    }),
  };
}

const truthy = (value: Value) => value === true;

function logical(
  op: 'and' | 'or',
  left: Typed,
  right: Typed,
  at: number,
): Typed {
  if (left.type !== 'bool' || right.type !== 'bool') {
    return typeError(`${op} takes two bools`, at);
  }
  return {
    type: 'bool',
    run:
      op === 'and'
        ? (variables) =>
            truthy(left.run(variables)) && truthy(right.run(variables))
        : (variables) =>
            truthy(left.run(variables)) || truthy(right.run(variables)),
  };
}

// --- Functions ---------------------------------------------------------

type Fn = (args: Typed[], at: number) => Typed;

const arity = (
  name: string,
  args: Typed[],
  min: number,
  max: number,
  at: number,
) => {
  if (args.length < min || args.length > max) {
    const count =
      min === max
        ? `${min}`
        : max === Infinity
          ? `${min} or more`
          : `${min} to ${max}`;
    typeError(`${name}() takes ${count} arguments`, at);
  }
};
const takes = (
  name: string,
  arg: Typed,
  types: readonly StaticType[],
  at: number,
) => {
  if (!types.includes(arg.type)) {
    typeError(`${name}() takes ${types.join(' or ')}, not ${arg.type}`, at);
  }
};
/** One function of one argument of the given types. */
const unary =
  (
    types: readonly StaticType[],
    result: (type: StaticType) => StaticType,
    apply: (value: Value, type: StaticType) => Value,
  ): ((name: string) => Fn) =>
  (name) =>
  (args, at) => {
    arity(name, args, 1, 1, at);
    takes(name, args[0]!, types, at);
    const type = args[0]!.type;
    return { type: result(type), run: strict(args, ([v]) => apply(v!, type)) };
  };
/** The type all of `args` share, or a type error. */
const unified = (name: string, args: Typed[], at: number): StaticType =>
  args.reduce<StaticType | undefined>(
    (type, arg) => (type === undefined ? undefined : common(type, arg.type)),
    'null',
  ) ?? typeError(`${name}() takes values of one type`, at);

const NUMBERS: readonly StaticType[] = ['int', 'decimal'];
const STRING: readonly StaticType[] = ['string'];

const FUNCTION_MAKERS: Record<string, (name: string) => Fn> = {
  /** `if(condition, then, else)`: null reads as false. */
  if: (name) => (args, at) => {
    arity(name, args, 3, 3, at);
    takes(name, args[0]!, ['bool'], at);
    const type = unified(name, args.slice(1), at);
    const [condition, then, otherwise] = args as [Typed, Typed, Typed];
    return {
      type,
      run: (variables) =>
        truthy(condition.run(variables))
          ? then.run(variables)
          : otherwise.run(variables),
    };
  },
  /** The first value that isn't null. */
  coalesce: (name) => (args, at) => {
    arity(name, args, 2, 8, at);
    const type = unified(name, args, at);
    return {
      type,
      run: (variables) => {
        for (const arg of args) {
          const value = arg.run(variables);
          if (value !== null) return value;
        }
        return null;
      },
    };
  },
  /** `round(x)` to a whole number, `round(x, 2)` to 2 decimals (0 to 10), half-up. */
  round: (name) => (args, at) => {
    arity(name, args, 1, 2, at);
    takes(name, args[0]!, NUMBERS, at);
    const places = args[1]?.literal ?? (args[1] ? -1 : 0);
    if (places < 0 || places > 10) {
      typeError(`${name}()'s places are a whole number from 0 to 10`, at);
    }
    return {
      type: places === 0 ? 'int' : 'decimal',
      run: strict([args[0]!], ([v]) => ({
        units: rescale(v as Decimal, places),
        scale: places,
      })),
    };
  },
  floor: unary(
    NUMBERS,
    () => 'int',
    (v) => ({ units: rescale(v as Decimal, 0, 'floor'), scale: 0 }),
  ),
  ceil: unary(
    NUMBERS,
    () => 'int',
    (v) => ({ units: rescale(v as Decimal, 0, 'ceiling'), scale: 0 }),
  ),
  abs: unary(
    ['int', 'decimal', 'money'],
    (type) => type,
    (v, type) => {
      if (type === 'money') return (v as Money).abs();
      const d = v as Decimal;
      return { units: d.units < 0n ? -d.units : d.units, scale: d.scale };
    },
  ),
  min: (name) => extreme(name, -1),
  max: (name) => extreme(name, 1),
  /** Characters (code points). */
  length: unary(
    STRING,
    () => 'int',
    (v) => ({ units: BigInt(codePoints(v as string)), scale: 0 }),
  ),
  lower: unary(
    STRING,
    () => 'string',
    (v) => (v as string).toLowerCase(),
  ),
  upper: unary(
    STRING,
    () => 'string',
    (v) => (v as string).toUpperCase(),
  ),
  trim: unary(
    STRING,
    () => 'string',
    (v) => (v as string).trim(),
  ),
  concat: (name) => (args, at) => {
    arity(name, args, 1, 16, at);
    for (const arg of args) takes(name, arg, STRING, at);
    return {
      type: 'string',
      run: strict(args, (values) => boundedText((values as string[]).join(''))),
    };
  },
  /** A value as text: `12.50 EUR`, `2026-01-31`, `true`. */
  text: unary(
    ['int', 'decimal', 'money', 'string', 'bool', 'date', 'datetime'],
    () => 'string',
    (v, type) => textOf(type, v),
  ),
  /** Whole days from the first to the second (negative when earlier): two dates, or two datetimes (toward zero). */
  daysBetween: (name) => (args, at) => {
    arity(name, args, 2, 2, at);
    const type = args[0]!.type;
    if ((type !== 'date' && type !== 'datetime') || args[1]!.type !== type) {
      typeError(`${name}() takes two dates or two datetimes`, at);
    }
    return {
      type: 'int',
      run: strict(args, ([a, b]) => ({
        units: BigInt(
          type === 'date'
            ? dayNumber(b as string)! - dayNumber(a as string)!
            : Math.trunc(((b as number) - (a as number)) / DAY),
        ),
        scale: 0,
      })),
    };
  },
  /** Whole minutes from the first datetime to the second (toward zero). */
  minutesBetween: (name) => (args, at) => {
    arity(name, args, 2, 2, at);
    takes(name, args[0]!, ['datetime'], at);
    takes(name, args[1]!, ['datetime'], at);
    return {
      type: 'int',
      run: strict(args, ([a, b]) => ({
        units: BigInt(Math.trunc(((b as number) - (a as number)) / 60_000)),
        scale: 0,
      })),
    };
  },
  /** A date `n` days later (earlier when negative). */
  addDays: (name) => (args, at) => {
    arity(name, args, 2, 2, at);
    takes(name, args[0]!, ['date'], at);
    takes(name, args[1]!, ['int'], at);
    return {
      type: 'date',
      run: strict(args, ([d, n]) => {
        const days = (n as Decimal).units;
        if (days > 3_650_000n || days < -3_650_000n) {
          fail('out_of_range', 'A date is out of range');
        }
        return dateOfDay(dayNumber(d as string)! + Number(days));
      }),
    };
  },
  /** `date('2026-01-31')`. */
  date: unary(
    STRING,
    () => 'date',
    (v) =>
      dayNumber(v as string) === undefined
        ? invalid(`'${v as string}'`, 'date')
        : v,
  ),
  /** `datetime('2026-01-31T09:00:00Z')`. */
  datetime: unary(
    STRING,
    () => 'datetime',
    (v) => datetimeOf(v as string) ?? invalid(`'${v as string}'`, 'datetime'),
  ),
};

function extreme(name: string, sign: 1 | -1): Fn {
  return (args, at) => {
    arity(name, args, 2, 8, at);
    const type = unified(name, args, at);
    if (!ORDERED.includes(type) || type === 'string') {
      typeError(`${name}() takes numbers, amounts, dates or datetimes`, at);
    }
    return {
      type,
      run: strict(args, (values) =>
        values.reduce((best, value) =>
          order(type, value, best) * sign > 0 ? value : best,
        ),
      ),
    };
  };
}

/** The allowlist: nothing else can be called. */
const FUNCTIONS = new Map<string, Fn>(
  Object.entries(FUNCTION_MAKERS).map(([name, make]) => [name, make(name)]),
);

// --- Parsing -----------------------------------------------------------

interface Token {
  kind: 'number' | 'string' | 'name' | 'op' | 'end';
  text: string;
  at: number;
}

const OPERATORS = [
  '==',
  '!=',
  '<=',
  '>=',
  '<',
  '>',
  '+',
  '-',
  '*',
  '/',
  '(',
  ')',
  ',',
];
const KEYWORDS = new Set(['and', 'or', 'not', 'true', 'false', 'null']);

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const char = source[i]!;
    if (/\s/.test(char)) {
      i++;
      continue;
    }
    const at = i;
    if (/\d/.test(char)) {
      const match = /^\d+(\.\d+)?/.exec(source.slice(i))![0];
      const whole = match.split('.')[0]!;
      if (whole.replace(/^0+(?=\d)/, '').length > EXPRESSION_LIMITS.digits) {
        fail('out_of_range', 'A number is out of range', at);
      }
      tokens.push({ kind: 'number', text: match, at });
      i += match.length;
      continue;
    }
    if (char === "'" || char === '"') {
      let text = '';
      i++;
      for (;;) {
        if (i >= source.length) fail('syntax', 'A string is not closed', at);
        const c = source[i]!;
        if (c === char) break;
        if (c === '\\') {
          const next = source[i + 1];
          if (next !== '\\' && next !== "'" && next !== '"') {
            fail('syntax', 'Only \\\\, \\\' and \\" are escapes', i);
          }
          text += next;
          i += 2;
          continue;
        }
        text += c;
        i++;
      }
      i++;
      if (text.length > EXPRESSION_LIMITS.text) {
        fail('too_long', 'A string is too long', at);
      }
      tokens.push({ kind: 'string', text, at });
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      const name = /^[A-Za-z_]\w*/.exec(source.slice(i))![0];
      tokens.push({ kind: 'name', text: name, at });
      i += name.length;
      continue;
    }
    const op = OPERATORS.find((candidate) => source.startsWith(candidate, i));
    if (!op) fail('syntax', `Unexpected "${char}"`, at);
    tokens.push({ kind: 'op', text: op!, at });
    i += op!.length;
  }
  tokens.push({ kind: 'end', text: '', at: source.length });
  return tokens;
}

/** A recursive-descent parser that type-checks as it goes and builds the evaluator. */
class Parser {
  private index = 0;
  private depth = 0;
  private nodes = 0;
  readonly reads = new Set<string>();

  constructor(
    private readonly tokens: Token[],
    private readonly variables: ReadonlyMap<string, ExpressionType>,
  ) {}

  parse(): Typed {
    const result = this.or();
    const next = this.peek();
    if (next.kind !== 'end') this.unexpected(next);
    return result;
  }

  private peek() {
    return this.tokens[this.index]!;
  }
  private next() {
    return this.tokens[this.index++]!;
  }
  private accept(kind: Token['kind'], text: string) {
    const token = this.peek();
    if (token.kind === kind && token.text === text) {
      this.index++;
      return token;
    }
    return undefined;
  }
  private expect(text: string) {
    const token = this.accept('op', text);
    if (!token) this.unexpected(this.peek(), `"${text}"`);
  }
  private unexpected(token: Token, wanted?: string): never {
    const seen = token.kind === 'end' ? 'the end' : `"${token.text}"`;
    return fail(
      'syntax',
      `Unexpected ${seen}${wanted ? `, expected ${wanted}` : ''}`,
      token.at,
    );
  }
  private node(at: number) {
    if (++this.nodes > EXPRESSION_LIMITS.nodes) {
      fail('too_complex', `More than ${EXPRESSION_LIMITS.nodes} parts`, at);
    }
  }
  private nested<T>(at: number, parse: () => T): T {
    if (++this.depth > EXPRESSION_LIMITS.depth) {
      fail('too_deep', `Nested more than ${EXPRESSION_LIMITS.depth} deep`, at);
    }
    const result = parse();
    this.depth--;
    return result;
  }

  private or(): Typed {
    let left = this.and();
    for (let token; (token = this.accept('name', 'or'));) {
      this.node(token.at);
      left = logical('or', left, this.and(), token.at);
    }
    return left;
  }
  private and(): Typed {
    let left = this.not();
    for (let token; (token = this.accept('name', 'and'));) {
      this.node(token.at);
      left = logical('and', left, this.not(), token.at);
    }
    return left;
  }
  private not(): Typed {
    const token = this.accept('name', 'not');
    if (!token) return this.comparison();
    this.node(token.at);
    const arg = this.nested(token.at, () => this.not());
    if (arg.type !== 'bool') typeError('not takes a bool', token.at);
    return { type: 'bool', run: (variables) => !truthy(arg.run(variables)) };
  }
  private comparison(): Typed {
    const left = this.additive();
    const token = this.peek();
    if (
      token.kind !== 'op' ||
      !['==', '!=', '<', '<=', '>', '>='].includes(token.text)
    ) {
      return left;
    }
    this.index++;
    this.node(token.at);
    const result = comparison(token.text, left, this.additive(), token.at);
    const after = this.peek();
    if (
      after.kind === 'op' &&
      ['==', '!=', '<', '<=', '>', '>='].includes(after.text)
    ) {
      fail('syntax', 'Comparisons do not chain: use and', after.at);
    }
    return result;
  }
  private additive(): Typed {
    let left = this.multiplicative();
    for (;;) {
      const token = this.accept('op', '+') ?? this.accept('op', '-');
      if (!token) return left;
      this.node(token.at);
      left = arithmetic(token.text, left, this.multiplicative(), token.at);
    }
  }
  private multiplicative(): Typed {
    let left = this.unary();
    for (;;) {
      const token = this.accept('op', '*') ?? this.accept('op', '/');
      if (!token) return left;
      this.node(token.at);
      left = arithmetic(token.text, left, this.unary(), token.at);
    }
  }
  private unary(): Typed {
    const token = this.accept('op', '-');
    if (!token) return this.primary();
    this.node(token.at);
    const arg = this.nested(token.at, () => this.unary());
    if (arg.type === 'money') {
      return {
        type: 'money',
        run: strict([arg], ([v]) => (v as Money).negated()),
      };
    }
    if (!isNumber(arg.type))
      typeError(`-${arg.type} is not an operation`, token.at);
    return {
      type: arg.type,
      run: strict([arg], ([v]) => ({
        units: -(v as Decimal).units,
        scale: (v as Decimal).scale,
      })),
    };
  }
  private primary(): Typed {
    const token = this.next();
    this.node(token.at);
    if (token.kind === 'number') {
      const value = toDecimal(token.text);
      return {
        type: value.scale === 0 ? 'int' : 'decimal',
        run: () => value,
        ...(value.scale === 0 &&
          value.units <= 10n && { literal: Number(value.units) }),
      };
    }
    if (token.kind === 'string') {
      const value = token.text;
      return { type: 'string', run: () => value };
    }
    if (token.kind === 'op' && token.text === '(') {
      const inner = this.nested(token.at, () => this.or());
      this.expect(')');
      return inner;
    }
    if (token.kind !== 'name') return this.unexpected(token);
    if (token.text === 'true' || token.text === 'false') {
      const value = token.text === 'true';
      return { type: 'bool', run: () => value };
    }
    if (token.text === 'null') return { type: 'null', run: () => null };
    if (KEYWORDS.has(token.text)) return this.unexpected(token);
    if (this.accept('op', '(')) return this.call(token);
    const type = this.variables.get(token.text);
    if (!type) {
      return fail('unknown_name', `Nothing is named "${token.text}"`, token.at);
    }
    const name = token.text;
    this.reads.add(name);
    return { type, run: (variables) => variables.get(name) ?? null };
  }
  private call(name: Token): Typed {
    const fn = FUNCTIONS.get(name.text);
    if (!fn) {
      return fail(
        'unknown_function',
        `No function is named "${name.text}"`,
        name.at,
      );
    }
    const args = this.nested(name.at, () => {
      const list: Typed[] = [];
      if (this.accept('op', ')')) return list;
      for (;;) {
        list.push(this.or());
        if (this.accept('op', ')')) return list;
        this.expect(',');
      }
    });
    return fn(args, name.at);
  }
}

/**
 * Compiles `source` against the names it may read (`{ quantity: 'int',
 * unitPrice: 'money' }`): an ExpressionError when it is not a valid,
 * well-typed expression within the limits, or always null.
 */
export function compileExpression(
  source: string,
  variables: Readonly<Record<string, ExpressionType>>,
): Expression {
  if (typeof source !== 'string') {
    fail('syntax', 'An expression is a string');
  }
  if (source.length > EXPRESSION_LIMITS.source) {
    fail('too_long', `Longer than ${EXPRESSION_LIMITS.source} characters`);
  }
  const types = new Map(
    Object.entries(variables).filter(([name]) =>
      Object.hasOwn(variables, name),
    ),
  );
  const parser = new Parser(tokenize(source), types);
  const root = parser.parse();
  if (root.type === 'null') {
    fail('type', 'The expression is always null');
  }
  const type = root.type as ExpressionType;
  const reads = [...parser.reads].sort((a, b) => a.localeCompare(b));
  return {
    source,
    type,
    reads,
    evaluate(values) {
      const inputs = new Map<string, Value>(
        reads.map((name) => [
          name,
          valueOf(
            name,
            types.get(name)!,
            Object.hasOwn(values, name) ? values[name] : undefined,
          ),
        ]),
      );
      try {
        return output(type, root.run(inputs));
      } catch (error) {
        if (error instanceof CurrencyMismatchError) {
          throw new ExpressionError('currency_mismatch', error.message);
        }
        throw error;
      }
    },
  };
}
