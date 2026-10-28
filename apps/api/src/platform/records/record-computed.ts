import { z } from 'zod';
import {
  compileExpression,
  type Expression,
  ExpressionError,
  type ExpressionType,
} from '../expressions/expression.js';
import type { AnyField, Fields } from '../fields/field.js';
import { moneyResponseSchema } from '../money/money.schemas.js';
import type { RecordDeclaration } from './record.js';

/**
 * A record's computed fields (`computed` in `<item>.record.ts`): values
 * derived from its fields by an expression (platform/expressions), declared
 * once, computed on read, never stored.
 *
 * ```ts
 * computed: {
 *   total: computed.money('quantity * unitPrice'),
 *   late: computed.bool('paidOn > dueOn'),
 *   days: computed.int('daysBetween(startOn, endOn) + 1'),
 * },
 * ```
 *
 * - Read-time: computed from the stored row each time a record is shown
 *   (RecordPresenter), so a change of a field it reads shows at once; no
 *   column, no migration, nothing to recalculate. Not filterable, sortable
 *   or searchable (no column to query), and not in exports, PDFs, webhooks,
 *   revisions or the audit log, which carry the fields it is computed from.
 * - Checked when the declaration loads (`defineRecord`): the expression
 *   compiles against the fields' types, its result is the declared kind,
 *   the names it reads exist (a JSON field can't be read), no computed
 *   field reads itself through others (a cycle), and no name is taken.
 * - Permission-aware: a reader who may not see a field it reads (on that
 *   record) doesn't get it either, nor a computed field that reads it.
 * - Null when a field it reads is null (unless it handles that:
 *   `coalesce()`, `== null`), and when it can't be computed (a division by
 *   zero, two currencies).
 */

/** What a computed field may be, each the API type of the field kind of that name. */
export type ComputedKind = ExpressionType;

const OUTPUTS = {
  int: z.number().int(),
  decimal: z.string(),
  money: moneyResponseSchema,
  string: z.string(),
  bool: z.boolean(),
  date: z.iso.date(),
  datetime: z.iso.datetime(),
} satisfies Record<ComputedKind, z.ZodType>;
type Outputs = typeof OUTPUTS;

export class ComputedField<K extends ComputedKind = ComputedKind> {
  constructor(
    readonly kind: K,
    readonly expression: string,
  ) {}

  get output(): Outputs[K] {
    return OUTPUTS[this.kind];
  }
}

/** The kinds of computed field: `computed.money('quantity * unitPrice')`. */
export const computed = {
  int: (expression: string) => new ComputedField('int', expression),
  decimal: (expression: string) => new ComputedField('decimal', expression),
  money: (expression: string) => new ComputedField('money', expression),
  string: (expression: string) => new ComputedField('string', expression),
  bool: (expression: string) => new ComputedField('bool', expression),
  date: (expression: string) => new ComputedField('date', expression),
  datetime: (expression: string) => new ComputedField('datetime', expression),
};

export type ComputedFields = Record<string, ComputedField>;

/** How an expression reads each field kind; a JSON field it can't. */
const READS: Partial<Record<AnyField['kind'], ExpressionType>> = {
  string: 'string',
  text: 'string',
  enum: 'string',
  ref: 'string',
  int: 'int',
  decimal: 'decimal',
  money: 'money',
  bool: 'bool',
  date: 'date',
  datetime: 'datetime',
};

/** What a record shows besides its fields: a computed field can't take these names. */
const TAKEN = [
  'id',
  'tenantId',
  'ownerId',
  'unitId',
  'number',
  'tags',
  'custom',
  'createdAt',
  'updatedAt',
  'deletedAt',
  'deletedBy',
  'search',
  'can',
  'watching',
];

interface Plan {
  /** In the order they compute: each after those it reads. */
  order: { name: string; field: ComputedField; expression: Expression }[];
  /** Each one's fields and computed fields read, directly or through others. */
  reads: Map<string, Set<string>>;
}

const PLANS = new WeakMap<RecordDeclaration, Plan>();

/** The variables an expression of the record may read: its fields, its dates, its computed fields. */
function variablesOf(fields: Fields, declared: ComputedFields) {
  const variables: Record<string, ExpressionType> = {
    createdAt: 'datetime',
    updatedAt: 'datetime',
  };
  for (const [name, f] of Object.entries(fields)) {
    const type = READS[f.kind];
    if (type) variables[name] = type;
  }
  for (const [name, f] of Object.entries(declared)) {
    variables[name] = f.kind;
  }
  return variables;
}

/**
 * Checks a declaration's computed fields and plans their computing
 * (defineRecord calls it): an Error naming the field and what is wrong.
 */
export function planComputed(declaration: RecordDeclaration) {
  const declared = declaration.computed ?? {};
  const subject = declaration.subject;
  const variables = variablesOf(declaration.fields, declared);
  const compiled = new Map<
    string,
    { field: ComputedField; expression: Expression }
  >();
  for (const [name, field] of Object.entries(declared)) {
    if (name in declaration.fields || TAKEN.includes(name)) {
      throw new Error(
        `${subject}: computed field "${name}" takes a name the record already shows.`,
      );
    }
    if (!(field instanceof ComputedField)) {
      throw new Error(
        `${subject}: computed field "${name}" is declared with computed.<kind>('…').`,
      );
    }
    let expression: Expression;
    try {
      expression = compileExpression(field.expression, variables);
    } catch (error) {
      if (error instanceof ExpressionError) {
        throw new Error(
          `${subject}: computed field "${name}": ${error.message} in \`${field.expression}\`.`,
        );
      }
      throw error;
    }
    // An int is a decimal too; nothing else converts.
    if (
      expression.type !== field.kind &&
      !(field.kind === 'decimal' && expression.type === 'int')
    ) {
      throw new Error(
        `${subject}: computed field "${name}" is declared ${field.kind}, but \`${field.expression}\` is ${expression.type}.`,
      );
    }
    compiled.set(name, { field, expression });
  }
  // Depth first: each after what it reads; a field met again on its own path is a cycle.
  const order: Plan['order'] = [];
  const reads = new Map<string, Set<string>>();
  const visit = (name: string, path: string[]): Set<string> => {
    const done = reads.get(name);
    if (done) return done;
    if (path.includes(name)) {
      throw new Error(
        `${subject}: computed fields form a cycle: ${[...path.slice(path.indexOf(name)), name].join(' → ')}.`,
      );
    }
    const entry = compiled.get(name)!;
    const all = new Set<string>();
    for (const read of entry.expression.reads) {
      all.add(read);
      if (compiled.has(read)) {
        for (const inner of visit(read, [...path, name])) all.add(inner);
      }
    }
    reads.set(name, all);
    order.push({ name, ...entry });
    return all;
  };
  for (const name of compiled.keys()) visit(name, []);
  PLANS.set(declaration, { order, reads });
}

const planOf = (declaration: RecordDeclaration) => PLANS.get(declaration);

/** Records as the API shows them (recordView), with their computed fields. */
export function withComputed(
  declaration: RecordDeclaration,
  views: Record<string, unknown>[],
): Record<string, unknown>[] {
  const plan = planOf(declaration);
  if (!plan?.order.length) return views;
  return views.map((view) => {
    const shown = { ...view };
    for (const { name, field, expression } of plan.order) {
      let value: unknown;
      try {
        value = expression.evaluate(shown);
      } catch (error) {
        // Not computable from these values (a division by zero, two currencies): null.
        if (!(error instanceof ExpressionError)) throw error;
        value = null;
      }
      shown[name] =
        field.kind === 'decimal' && typeof value === 'number'
          ? String(value)
          : value;
    }
    return shown;
  });
}

/**
 * `shown` (the records `withComputed` made, redacted) without the computed
 * fields that read what redaction took out of a record: a value computed
 * from a hidden field would tell it.
 */
export function hideComputed(
  declaration: RecordDeclaration,
  views: Record<string, unknown>[],
  shown: Record<string, unknown>[],
) {
  const plan = planOf(declaration);
  if (!plan?.order.length) return shown;
  return shown.map((record, i) => {
    const view = views[i]!;
    const hidden = Object.keys(view).filter((key) => !(key in record));
    if (hidden.length === 0) return record;
    const kept = { ...record };
    for (const [name, reads] of plan.reads) {
      if (hidden.some((key) => reads.has(key))) delete kept[name];
    }
    return kept;
  });
}

type ComputedShape<C> = {
  [N in keyof C]: C[N] extends ComputedField<infer K>
    ? z.ZodOptional<z.ZodNullable<Outputs[K]>>
    : never;
};

/** The computed fields' part of a record's response schema. */
export function computedSchemas<C extends ComputedFields | undefined>(
  declared: C,
): ComputedShape<NonNullable<C>> {
  return Object.fromEntries(
    Object.entries(declared ?? {}).map(([name, f]) => [
      name,
      f.output
        .nullable()
        .optional()
        .describe(
          `Computed: \`${f.expression}\` (read-only). Null when a value it reads is empty or it can't be computed; left out when your permissions hide a field it reads.`,
        ),
    ]),
  ) as ComputedShape<NonNullable<C>>;
}
