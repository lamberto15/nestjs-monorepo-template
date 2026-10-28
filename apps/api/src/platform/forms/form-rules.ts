/**
 * A form's declarative conditions (docs/forms.md, "Conditions"): when a
 * field or a section shows (`visibleWhen`) and when a field is required
 * (`requiredWhen`). A condition is data, a small tree of predicates on the
 * answers of fields **before** it, never code: no eval, no expression
 * language, no pattern from an administrator. Pure functions, without
 * imports: the web app mirrors this file (apps/web/src/features/forms/rules.ts)
 * and its contract test runs both on the same cases.
 *
 * Reading only earlier fields makes a cycle impossible and lets one pass in
 * form order decide everything: a field hidden (or its section) has no
 * answer, so conditions on it read it as empty.
 */

/** A value a predicate compares with: a field's answer type. */
export type RuleValue = string | number | boolean;

export type RulePredicate =
  | { field: string; op: 'eq' | 'ne'; value: RuleValue }
  | { field: string; op: 'gt' | 'gte' | 'lt' | 'lte'; value: number | string }
  | { field: string; op: 'in'; value: (string | number)[] }
  | { field: string; op: 'contains'; value: string }
  | { field: string; op: 'isEmpty' };

export type RuleCondition =
  | RulePredicate
  | { all: RuleCondition[] }
  | { any: RuleCondition[] }
  | { not: RuleCondition };

export const RULE_OPERATORS = [
  'eq',
  'ne',
  'gt',
  'gte',
  'lt',
  'lte',
  'in',
  'contains',
  'isEmpty',
] as const;
export type RuleOperator = (typeof RULE_OPERATORS)[number];

/** Hard limits of one condition, whatever an administrator asks. */
export const RULE_LIMITS = {
  /** Groups (all / any / not) inside each other. */
  depth: 4,
  /** Predicates in one condition. */
  predicates: 20,
  /** Values of one `in`. */
  values: 50,
};

/** What a condition needs to know of a field. */
export interface RuleField {
  key: string;
  type: string;
  options?: readonly { value: string }[];
}

/** The operators each field type takes (a predicate on another type is refused). */
export const OPERATORS_BY_TYPE: Record<string, readonly RuleOperator[]> = {
  text: ['eq', 'ne', 'in', 'isEmpty'],
  textarea: ['isEmpty'],
  email: ['eq', 'ne', 'in', 'isEmpty'],
  url: ['isEmpty'],
  integer: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'isEmpty'],
  decimal: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'isEmpty'],
  date: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'isEmpty'],
  checkbox: ['eq', 'ne'],
  select: ['eq', 'ne', 'in', 'isEmpty'],
  radio: ['eq', 'ne', 'in', 'isEmpty'],
  multiSelect: ['contains', 'isEmpty'],
  // A repeatable group (format 3): whether it has items.
  group: ['isEmpty'],
};

const isGroup = (
  condition: RuleCondition,
): condition is
  | { all: RuleCondition[] }
  | { any: RuleCondition[] }
  | { not: RuleCondition } =>
  'all' in condition || 'any' in condition || 'not' in condition;

const isEmptyValue = (value: unknown) =>
  value === undefined ||
  value === null ||
  value === '' ||
  (Array.isArray(value) && value.length === 0);

/** `a` before `b`: numbers as numbers, dates (`YYYY-MM-DD`) as text; other pairs never compare. */
const compare = (a: unknown, b: unknown): number | null => {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'string' && typeof b === 'string') {
    if (a === b) return 0;
    return a < b ? -1 : 1;
  }
  return null;
};

/**
 * Whether a condition holds for these answers (normalized: numbers as
 * numbers, a checkbox as a boolean, a multiSelect as a list). A missing
 * answer is empty: every comparison with it is false, `ne` true, `isEmpty`
 * true. Bounded by RULE_LIMITS, checked when the definition is saved.
 */
export function evaluate(
  condition: RuleCondition,
  answers: Readonly<Record<string, unknown>>,
): boolean {
  if ('all' in condition) {
    return condition.all.every((part) => evaluate(part, answers));
  }
  if ('any' in condition) {
    return condition.any.some((part) => evaluate(part, answers));
  }
  if ('not' in condition) return !evaluate(condition.not, answers);
  const answer = Object.hasOwn(answers, condition.field)
    ? answers[condition.field]
    : undefined;
  switch (condition.op) {
    case 'isEmpty':
      return isEmptyValue(answer);
    case 'eq':
      return answer === condition.value;
    case 'ne':
      return answer !== condition.value;
    case 'in':
      return (condition.value as unknown[]).includes(answer);
    case 'contains':
      return Array.isArray(answer) && answer.includes(condition.value);
    default: {
      const order = compare(answer, condition.value);
      if (order === null) return false;
      if (condition.op === 'gt') return order > 0;
      if (condition.op === 'gte') return order >= 0;
      if (condition.op === 'lt') return order < 0;
      return order <= 0;
    }
  }
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Whether a predicate's value has the type its field's answers have. */
function valueFits(field: RuleField, value: unknown): boolean {
  switch (field.type) {
    case 'integer':
      return Number.isSafeInteger(value);
    case 'decimal':
      return typeof value === 'number' && Number.isFinite(value);
    case 'checkbox':
      return typeof value === 'boolean';
    case 'date':
      return typeof value === 'string' && DATE.test(value);
    case 'select':
    case 'radio':
    case 'multiSelect':
      return (
        typeof value === 'string' &&
        (field.options ?? []).some((option) => option.value === value)
      );
    default:
      return typeof value === 'string' && value.length <= 1_000;
  }
}

export interface RuleIssue {
  /** Dotted, under the condition: `all.1.value`; empty for the whole condition. */
  path: string;
  message: string;
}

/**
 * A condition's problems (empty: valid), given the fields it may read (the
 * ones before it in the form, by key): an unknown or later field (which
 * would allow a cycle), an operator its type doesn't take, a value not of
 * its type or not among its options, and nesting or size over RULE_LIMITS.
 */
export function conditionIssues(
  condition: RuleCondition,
  earlier: ReadonlyMap<string, RuleField>,
  later: ReadonlySet<string> = new Set(),
): RuleIssue[] {
  const issues: RuleIssue[] = [];
  let predicates = 0;
  const walk = (part: RuleCondition, path: string, depth: number) => {
    const at = (name: string) => (path ? `${path}.${name}` : name);
    if (isGroup(part)) {
      if (depth >= RULE_LIMITS.depth) {
        issues.push({
          path,
          message: `At most ${RULE_LIMITS.depth} groups inside each other.`,
        });
        return;
      }
      if ('not' in part) {
        walk(part.not, at('not'), depth + 1);
        return;
      }
      const name = 'all' in part ? 'all' : 'any';
      const parts = 'all' in part ? part.all : part.any;
      if (parts.length === 0) {
        issues.push({ path: at(name), message: 'A group needs conditions.' });
      }
      parts.forEach((child, index) =>
        walk(child, at(`${name}.${index}`), depth + 1),
      );
      return;
    }
    predicates++;
    const field = earlier.get(part.field);
    if (!field) {
      issues.push({
        path: at('field'),
        message: later.has(part.field)
          ? `"${part.field}" comes later in the form (or is this field): a condition reads only fields before it.`
          : `No field "${part.field}" in the form.`,
      });
      return;
    }
    if (!(OPERATORS_BY_TYPE[field.type] ?? []).includes(part.op)) {
      issues.push({
        path: at('op'),
        message: `A ${field.type} field takes no ${part.op}.`,
      });
      return;
    }
    if (part.op === 'isEmpty') return;
    if (part.op === 'in') {
      if (part.value.length === 0 || part.value.length > RULE_LIMITS.values) {
        issues.push({
          path: at('value'),
          message: `From 1 to ${RULE_LIMITS.values} values.`,
        });
      }
      part.value.forEach((value, index) => {
        if (!valueFits(field, value)) {
          issues.push({
            path: at(`value.${index}`),
            message: `Not a value of "${field.key}".`,
          });
        }
      });
      return;
    }
    if (!valueFits(field, part.value)) {
      issues.push({
        path: at('value'),
        message: `Not a value of "${field.key}".`,
      });
    }
  };
  walk(condition, '', 0);
  if (predicates > RULE_LIMITS.predicates) {
    issues.push({
      path: '',
      message: `At most ${RULE_LIMITS.predicates} conditions in one rule.`,
    });
  }
  return issues;
}

/** What a pass over a form needs of a section. */
export interface RuleSection<F extends RuleField> {
  key: string;
  visibleWhen?: RuleCondition;
  fields: readonly (F & {
    required?: boolean;
    visibleWhen?: RuleCondition;
    requiredWhen?: RuleCondition;
  })[];
}

/**
 * One pass over a form in order: for each field, whether it shows and
 * whether it is required, from the answers of the fields before it that
 * show. `answerOf` gives a field's normalized answer once it is decided
 * (undefined: none); a hidden field's answer is never read, so a condition
 * on it sees it empty. The server and the web app decide the same way.
 */
export function walkForm<F extends RuleField>(
  sections: readonly RuleSection<F>[],
  answerOf: (
    field: RuleSection<F>['fields'][number],
    required: boolean,
  ) => unknown,
): { visible: Set<string>; answers: Record<string, unknown> } {
  const answers: Record<string, unknown> = {};
  const visible = new Set<string>();
  for (const section of sections) {
    const shown =
      section.visibleWhen === undefined ||
      evaluate(section.visibleWhen, answers);
    for (const field of section.fields) {
      if (
        !shown ||
        (field.visibleWhen !== undefined &&
          !evaluate(field.visibleWhen, answers))
      ) {
        continue;
      }
      visible.add(field.key);
      const required =
        field.required === true ||
        (field.requiredWhen !== undefined &&
          evaluate(field.requiredWhen, answers));
      const answer = answerOf(field, required);
      if (answer !== undefined) answers[field.key] = answer;
    }
  }
  return { visible, answers };
}
