// A feature's fields (`--fields "title:string,amount:money?,status:enum(a|b)"`)
// and what each type becomes in the generated files: its column, its Zod
// schemas, its list filter, how a body's value is written and how a row's
// is shown, and sample values for the generated e2e test.
import { snake } from './names.mjs';

const CAMEL = /^[a-z][a-zA-Z0-9]*$/;

/** The columns every feature table has: no field may take their names. */
export const RESERVED = new Set([
  'id',
  'tenantId',
  'ownerId',
  'teamId',
  'createdAt',
  'updatedAt',
  'deletedAt',
  'deletedBy',
  'custom',
  'search',
]);

/** One field, from `name:type`, `name:type?` (optional), `name:type!unique`. */
export function parseField(spec) {
  const match = /^([^:]+):([a-z]+)(?:\(([^)]*)\))?(\?)?(!unique)?$/.exec(
    spec.trim(),
  );
  if (!match) {
    throw new Error(
      `--fields "${spec}": write name:type, with ? for optional and !unique for unique (title:string, dueOn:date?, code:string!unique).`,
    );
  }
  const [, name, type, arg, optional, unique] = match;
  if (!CAMEL.test(name)) {
    throw new Error(`--fields: "${name}" is a camelCase name (dueOn).`);
  }
  if (RESERVED.has(name)) {
    throw new Error(
      `--fields: "${name}" is a column every feature has already.`,
    );
  }
  const kind = TYPES[type];
  if (!kind) {
    throw new Error(
      `--fields: "${type}" is not a type; one of ${Object.keys(TYPES).join(', ')}.`,
    );
  }
  const field = {
    name,
    column: snake(name),
    type,
    optional: !!optional,
    unique: !!unique,
  };
  if (type === 'enum') {
    const values = (arg ?? '').split('|').filter(Boolean);
    if (
      values.length < 2 ||
      !values.every((value) => /^[a-z][a-z0-9-]*$/.test(value))
    ) {
      throw new Error(
        `--fields: "${name}:enum(…)" lists two values or more, lowercase: enum(draft|sent|paid).`,
      );
    }
    field.values = values;
  } else if (type === 'ref') {
    if (!arg || !/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(arg)) {
      throw new Error(
        `--fields: "${name}:ref(…)" names a feature: ref(customers).`,
      );
    }
    if (!name.endsWith('Id')) {
      throw new Error(
        `--fields: a reference's name ends with Id: ${name}Id:ref(${arg}).`,
      );
    }
    if (!optional) {
      // The generated test can't make the other feature's record.
      throw new Error(
        `--fields: "${name}:ref(${arg})" is optional for now (${name}:ref(${arg})?): make it required by hand once both features exist.`,
      );
    }
    field.ref = arg;
  } else if (arg !== undefined) {
    throw new Error(`--fields: "${type}" takes no (…).`);
  }
  if (unique && !['string', 'int'].includes(type)) {
    throw new Error(`--fields: !unique applies to string and int fields.`);
  }
  if (unique && optional) {
    throw new Error(`--fields: "${name}" can't be both optional and unique.`);
  }
  return field;
}

/** Every field of `--fields`, names unique. */
export function parseFields(list) {
  const fields = (list ?? '')
    .split(',')
    .map((spec) => spec.trim())
    .filter(Boolean)
    .map(parseField);
  if (fields.length === 0) {
    throw new Error(
      '--fields: give at least one field (--fields "title:string").',
    );
  }
  const seen = new Set();
  for (const field of fields) {
    if (seen.has(field.name)) {
      throw new Error(`--fields: "${field.name}" is given twice.`);
    }
    seen.add(field.name);
  }
  return fields;
}

const notNull = (field) => (field.optional ? '' : '.notNull()');
const nullable = (field) => (field.optional ? '.nullable()' : '');
const optionalInput = (field) =>
  field.optional ? '.nullable().optional()' : '';

/**
 * Each type: `column(field, t)` the table's entry (`t` the names),
 * `imports` what the files need, `input`/`output` Zod expressions,
 * `list` its filter (or null), `write`/`show` the value's mapping when the
 * column isn't the API's shape, `sample`/`changed` values for the test.
 */
export const TYPES = {
  string: {
    column: (f) => `text('${f.column}')${notNull(f)}`,
    pg: ['text'],
    input: (f) => `z.string().trim().min(1).max(200)${optionalInput(f)}`,
    output: (f) => `z.string()${nullable(f)}`,
    list: () => ({
      type: 'string',
      ops: ['eq', 'contains', 'startsWith'],
      sortable: true,
    }),
    sample: (f) => `'${f.name} 1'`,
    changed: (f) => `'${f.name} 2'`,
  },
  text: {
    column: (f) => `text('${f.column}')${notNull(f)}`,
    pg: ['text'],
    input: (f) => `z.string().max(10_000)${optionalInput(f)}`,
    output: (f) => `z.string()${nullable(f)}`,
    list: () => ({ type: 'string', ops: ['contains'], sortable: false }),
    sample: () => `'Some text.'`,
    changed: () => `'Other text.'`,
  },
  int: {
    column: (f) => `integer('${f.column}')${notNull(f)}`,
    pg: ['integer'],
    input: (f) => `z.number().int()${optionalInput(f)}`,
    output: (f) => `z.number().int()${nullable(f)}`,
    list: () => ({
      type: 'number',
      ops: ['eq', 'gt', 'gte', 'lt', 'lte', 'between'],
      sortable: true,
    }),
    sample: () => '3',
    changed: () => '4',
  },
  decimal: {
    // numeric: exact, read as a string (docs/money.md).
    column: (f) => `numeric('${f.column}')${notNull(f)}`,
    pg: ['numeric'],
    money: ['decimalSchema'],
    input: (f) => `decimalSchema${optionalInput(f)}`,
    output: (f) => `z.string()${nullable(f)}`,
    list: () => ({
      type: 'number',
      ops: ['gt', 'gte', 'lt', 'lte'],
      sortable: true,
    }),
    sample: () => `'12.50'`,
    changed: () => `'13.75'`,
  },
  money: {
    // Minor units and the currency (docs/money.md): `{ amount, currency }` in the API.
    column: (f) =>
      `...moneyColumns('${f.name}'${f.optional ? ', { nullable: true }' : ''})`,
    spread: true,
    columns: (f) => [`${f.name}Minor`, `${f.name}Currency`],
    moneyColumns: true,
    money: ['moneySchema', 'moneyResponseSchema'],
    input: (f) => `moneySchema${optionalInput(f)}`,
    output: (f) => `moneyResponseSchema${nullable(f)}`,
    list: (f) => ({
      key: `${f.name}Currency`,
      column: `${f.name}Currency`,
      type: 'string',
      ops: ['eq', 'in'],
      sortable: false,
    }),
    write: (f, value) =>
      f.optional
        ? `...(${value} !== undefined && (${value} === null ? { ${f.name}Minor: null, ${f.name}Currency: null } : moneyValues('${f.name}', Money.of(${value}.amount, ${value}.currency))))`
        : `...(${value} !== undefined && moneyValues('${f.name}', Money.of(${value}.amount, ${value}.currency)))`,
    show: (f) => `${f.name}: moneyOf(row, '${f.name}')?.toJSON() ?? null`,
    sample: () => `{ amount: '19.99', currency: 'EUR' }`,
    changed: () => `{ amount: '25.00', currency: 'EUR' }`,
  },
  bool: {
    column: (f) =>
      `boolean('${f.column}')${f.optional ? '' : '.notNull().default(false)'}`,
    pg: ['boolean'],
    input: (f) =>
      `z.boolean()${f.optional ? '.nullable().optional()' : '.optional()'}`,
    output: (f) => `z.boolean()${nullable(f)}`,
    list: () => ({ type: 'boolean', ops: ['eq'], sortable: true }),
    sample: () => 'true',
    changed: () => 'false',
  },
  date: {
    // A calendar day, no time zone: `2026-01-31`.
    column: (f) => `date('${f.column}', { mode: 'string' })${notNull(f)}`,
    pg: ['date'],
    input: (f) => `z.iso.date()${optionalInput(f)}`,
    output: (f) => `z.iso.date()${nullable(f)}`,
    list: () => ({
      type: 'date',
      ops: ['eq', 'gt', 'gte', 'lt', 'lte', 'between'],
      sortable: true,
    }),
    sample: () => `'2026-01-31'`,
    changed: () => `'2026-02-28'`,
  },
  datetime: {
    // A point in time (timestamptz, UTC in the API).
    column: (f) => `at('${f.column}')${notNull(f)}`,
    at: true,
    input: (f) => `z.iso.datetime()${optionalInput(f)}`,
    output: (f) => `z.iso.datetime()${nullable(f)}`,
    list: () => ({
      type: 'datetime',
      ops: ['gt', 'gte', 'lt', 'lte', 'between'],
      sortable: true,
    }),
    write: (f, value) =>
      `...(${value} !== undefined && { ${f.name}: ${value} === null ? null : new Date(${value}) })`,
    sample: () => `'2026-01-31T09:00:00.000Z'`,
    changed: () => `'2026-02-28T17:30:00.000Z'`,
  },
  enum: {
    column: (f, t) =>
      `text('${f.column}').$type<${t.Singular}${pascalOf(f.name)}>()${notNull(f)}`,
    pg: ['text'],
    input: (f, t) => `z.enum(${valuesConst(f, t)})${optionalInput(f)}`,
    output: (f, t) => `z.enum(${valuesConst(f, t)})${nullable(f)}`,
    list: (f, t) => ({
      type: 'enum',
      values: valuesConst(f, t),
      ops: ['eq', 'ne', 'in', 'notIn'],
      sortable: true,
    }),
    sample: (f) => `'${f.values[0]}'`,
    changed: (f) => `'${f.values[1]}'`,
  },
  json: {
    column: (f) =>
      `jsonb('${f.column}').$type<Record<string, unknown>>()${notNull(f)}`,
    pg: ['jsonb'],
    input: (f) => `z.record(z.string(), z.unknown())${optionalInput(f)}`,
    output: (f) => `z.record(z.string(), z.unknown())${nullable(f)}`,
    list: () => null,
    sample: () => `{ size: 'm' }`,
    changed: () => `{ size: 'l' }`,
  },
  ref: {
    // A key within the tenant (tenantReference): never another tenant's record.
    column: (f) => `uuid('${f.column}')`,
    pg: ['uuid'],
    input: (f) => `z.uuid()${optionalInput(f)}`,
    output: (f) => `z.uuid()${nullable(f)}`,
    list: () => ({
      type: 'uuid',
      ops: ['eq', 'in', 'isNull'],
      sortable: false,
    }),
    sample: () => 'null',
    changed: () => 'null',
  },
};

export const pascalOf = (camelName) =>
  camelName[0].toUpperCase() + camelName.slice(1);
/** `INVOICE_STATUSES`: an enum field's values, exported by the schemas file. */
export const valuesConst = (f, t) =>
  `${t.SINGULAR}_${snake(f.name).toUpperCase()}_VALUES`;
