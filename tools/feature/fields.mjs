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
  'unitId',
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
  // A group that did not take part (no `(…)`, no `?`, no `!unique`) is undefined.
  const [, name, type, arg, optional, unique] =
    /** @type {(string | undefined)[]} */ (match);
  if (!CAMEL.test(name)) {
    throw new Error(`--fields: "${name}" is a camelCase name (dueOn).`);
  }
  if (RESERVED.has(name)) {
    throw new Error(
      `--fields: "${name}" is a column every feature has already.`,
    );
  }
  if (!TYPES.includes(type)) {
    throw new Error(
      `--fields: "${type}" is not a type; one of ${TYPES.join(', ')}.`,
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

/** `customer-notes` → `customerNotes`: a feature's table constant. */
export const camelOf = (kebab) =>
  kebab
    .split('-')
    .map((word, i) => (i === 0 ? word : word[0].toUpperCase() + word.slice(1)))
    .join('');

export const pascalOf = (camelName) =>
  camelName[0].toUpperCase() + camelName.slice(1);

const CALLS = {
  string: 'field.string()',
  text: 'field.text()',
  int: 'field.int()',
  decimal: 'field.decimal()',
  money: 'field.money()',
  bool: 'field.bool()',
  date: 'field.date()',
  datetime: 'field.datetime()',
  json: 'field.json()',
};

/**
 * A field as its declaration in `<item>.record.ts` (platform/fields):
 * `field.money().optional()`. String and text fields search with `search`.
 */
export function builderOf(f, { searchable = false } = {}) {
  const call =
    f.type === 'enum'
      ? `field.enum([${f.values.map((value) => `'${value}'`).join(', ')}])`
      : f.type === 'ref'
        ? `field.ref(() => ${camelOf(f.ref)})`
        : CALLS[f.type];
  return [
    call,
    f.unique ? '.unique()' : '',
    f.optional ? '.optional()' : '',
    searchable && (f.type === 'string' || f.type === 'text')
      ? '.searchable()'
      : '',
  ].join('');
}

/** The types `--fields` takes. */
export const TYPES = [...Object.keys(CALLS), 'enum', 'ref'];
