import type { components } from '@nestjs-monorepo-template/api-client';

/**
 * A form's conditions (docs/forms.md, "Conditions"), as the browser decides
 * them: a mirror of the API's apps/api/src/platform/forms/form-rules.ts,
 * which stays authoritative. rules.test.ts runs both on the same cases, so
 * what shows and what is required here is what the server checks. Data,
 * never code: predicates on the answers of earlier fields, no eval.
 */
export type FormCondition = components['schemas']['FormCondition'];
export type ConditionOperator = Extract<FormCondition, { op: string }>['op'];

/** The operators each field type takes (form-rules.ts, OPERATORS_BY_TYPE). */
export const OPERATORS_BY_TYPE: Record<string, readonly ConditionOperator[]> = {
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
};

const isEmptyValue = (value: unknown) =>
  value === undefined ||
  value === null ||
  value === '' ||
  (Array.isArray(value) && value.length === 0);

const compare = (a: unknown, b: unknown): number | null => {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'string' && typeof b === 'string') {
    if (a === b) return 0;
    return a < b ? -1 : 1;
  }
  return null;
};

/** Whether a condition holds for these (normalized) answers; a missing one is empty. */
export function evaluate(
  condition: FormCondition,
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

interface WalkSection<F> {
  visibleWhen?: FormCondition;
  fields: readonly F[];
}
interface WalkField {
  key: string;
  required?: boolean;
  visibleWhen?: FormCondition;
  requiredWhen?: FormCondition;
}

/**
 * One pass in form order (form-rules.ts, walkForm): which fields show and
 * which are required, from the answers of the earlier fields that show.
 * `answerOf` gives a shown field's normalized answer (undefined: none).
 */
export function walkForm<F extends WalkField>(
  sections: readonly WalkSection<F>[],
  answerOf: (field: F, required: boolean) => unknown,
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
