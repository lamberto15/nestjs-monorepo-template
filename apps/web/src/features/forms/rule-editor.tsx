import { Button } from '@nestjs-monorepo-template/ui/components/button';
import {
  Field,
  FieldDescription,
  FieldLabel,
} from '@nestjs-monorepo-template/ui/components/field';
import { Input } from '@nestjs-monorepo-template/ui/components/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@nestjs-monorepo-template/ui/components/select';
import { PlusIcon, TrashIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { FormField } from './api';
import {
  type ConditionOperator,
  type FormCondition,
  OPERATORS_BY_TYPE,
} from './rules';

type Predicate = Extract<FormCondition, { op: string }>;
type Combinator = 'all' | 'any';

/**
 * A condition as the editor shows it: one list of predicates, all or any
 * of them. Deeper trees (`not`, groups in groups) are valid on the API but
 * not edited here: they show as such, and can only be removed.
 */
function flatten(
  condition: FormCondition | undefined,
): { combinator: Combinator; predicates: Predicate[] } | null {
  if (condition === undefined) return { combinator: 'all', predicates: [] };
  if ('op' in condition) return { combinator: 'all', predicates: [condition] };
  if ('not' in condition) return null;
  const combinator: Combinator = 'all' in condition ? 'all' : 'any';
  const parts = 'all' in condition ? condition.all : condition.any;
  return parts.every((part) => 'op' in part)
    ? { combinator, predicates: parts as Predicate[] }
    : null;
}

function build(
  combinator: Combinator,
  predicates: Predicate[],
): FormCondition | undefined {
  if (predicates.length === 0) return undefined;
  if (predicates.length === 1) return predicates[0];
  return combinator === 'all' ? { all: predicates } : { any: predicates };
}

/** A first value of the field's type, so a new predicate is valid at once. */
function predicateFor(field: FormField): Predicate {
  const op = OPERATORS_BY_TYPE[field.type]![0]!;
  return withOperator(field, { field: field.key, op: 'isEmpty' }, op);
}

function withOperator(
  field: FormField,
  predicate: Predicate,
  op: ConditionOperator,
): Predicate {
  if (op === 'isEmpty') return { field: field.key, op };
  const first = field.options?.[0]?.value;
  const scalar =
    field.type === 'checkbox'
      ? true
      : field.type === 'integer' || field.type === 'decimal'
        ? 0
        : field.type === 'date'
          ? new Date().toISOString().slice(0, 10)
          : (first ?? '');
  const previous = 'value' in predicate ? predicate.value : undefined;
  const kept = Array.isArray(previous) ? previous[0] : previous;
  const value = typeof kept === typeof scalar ? kept! : scalar;
  if (op === 'in') {
    return { field: field.key, op, value: [value as string | number] };
  }
  if (op === 'contains') {
    return { field: field.key, op, value: String(first ?? '') };
  }
  return { field: field.key, op, value } as Predicate;
}

/**
 * The visual editor of one condition (docs/forms.md, "Conditions"): rows of
 * field, operator and value, on the fields before this one only (what the
 * API takes), joined by all or any. No expression is typed anywhere.
 */
export function RuleEditor(props: {
  id: string;
  label: string;
  condition: FormCondition | undefined;
  /** The fields a condition here may read: the ones before it. */
  earlier: readonly FormField[];
  onChange: (condition: FormCondition | undefined) => void;
}) {
  const { t } = useTranslation('forms');
  const flat = flatten(props.condition);
  if (flat === null) {
    return (
      <div className="flex items-center justify-between gap-2 text-sm">
        <span>
          {props.label}: {t('rules.nested')}
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => props.onChange(undefined)}
        >
          {t('rules.clear')}
        </Button>
      </div>
    );
  }
  const { combinator, predicates } = flat;
  const set = (next: Predicate[], join = combinator) =>
    props.onChange(build(join, next));

  return (
    <fieldset
      className="flex flex-col gap-2 rounded-md border border-dashed p-2"
      aria-label={props.label}
    >
      <legend className="px-1 text-sm font-medium">{props.label}</legend>
      {predicates.length === 0 && (
        <p className="text-sm text-muted-foreground">{t('rules.always')}</p>
      )}
      {predicates.length > 1 && (
        <Choice
          id={`${props.id}-join`}
          label={t('rules.join')}
          value={combinator}
          items={[
            { value: 'all', label: t('rules.all') },
            { value: 'any', label: t('rules.any') },
          ]}
          onChange={(value) => set(predicates, value as Combinator)}
        />
      )}
      {predicates.map((predicate, index) => (
        <PredicateRow
          key={index}
          id={`${props.id}-${index}`}
          predicate={predicate}
          earlier={props.earlier}
          onChange={(next) =>
            set(predicates.map((p, i) => (i === index ? next : p)))
          }
          onRemove={() => set(predicates.filter((_, i) => i !== index))}
        />
      ))}
      {props.earlier.length === 0 ? (
        <FieldDescription>{t('rules.noEarlier')}</FieldDescription>
      ) : (
        <div>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              set([...predicates, predicateFor(props.earlier.at(-1)!)])
            }
          >
            <PlusIcon />
            {t('rules.add')}
          </Button>
        </div>
      )}
    </fieldset>
  );
}

function PredicateRow(props: {
  id: string;
  predicate: Predicate;
  earlier: readonly FormField[];
  onChange: (predicate: Predicate) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation('forms');
  const { predicate } = props;
  const field = props.earlier.find((f) => f.key === predicate.field);
  const operators = field ? OPERATORS_BY_TYPE[field.type]! : [];
  return (
    <div className="grid items-end gap-2 sm:grid-cols-[1fr_1fr_1fr_auto]">
      <Choice
        id={`${props.id}-field`}
        label={t('rules.field')}
        value={predicate.field}
        items={props.earlier.map((f) => ({ value: f.key, label: f.label }))}
        onChange={(key) => {
          const next = props.earlier.find((f) => f.key === key);
          if (next) props.onChange(predicateFor(next));
        }}
      />
      <Choice
        id={`${props.id}-op`}
        label={t('rules.operator')}
        value={predicate.op}
        items={operators.map((op) => ({
          value: op,
          label: t(`rules.ops.${op}`),
        }))}
        onChange={(op) =>
          field &&
          props.onChange(
            withOperator(field, predicate, op as ConditionOperator),
          )
        }
      />
      {field && predicate.op !== 'isEmpty' ? (
        <ValueInput
          id={`${props.id}-value`}
          field={field}
          predicate={predicate}
          onChange={props.onChange}
        />
      ) : (
        <span />
      )}
      <Button
        variant="ghost"
        size="icon"
        aria-label={t('rules.remove')}
        onClick={props.onRemove}
      >
        <TrashIcon />
      </Button>
    </div>
  );
}

function ValueInput(props: {
  id: string;
  field: FormField;
  predicate: Exclude<Predicate, { op: 'isEmpty' }>;
  onChange: (predicate: Predicate) => void;
}) {
  const { t } = useTranslation('forms');
  const { field, predicate } = props;
  const numeric = field.type === 'integer' || field.type === 'decimal';
  const label = t('rules.value');
  if (predicate.op === 'in') {
    return (
      <Field>
        <FieldLabel htmlFor={props.id}>{t('rules.values')}</FieldLabel>
        <Input
          id={props.id}
          defaultValue={predicate.value.join(', ')}
          onChange={(event) =>
            props.onChange({
              ...predicate,
              value: event.target.value
                .split(',')
                .map((part) => part.trim())
                .filter(Boolean)
                .map((part) => (numeric ? Number(part) : part)),
            })
          }
        />
      </Field>
    );
  }
  if (field.type === 'checkbox') {
    return (
      <Choice
        id={props.id}
        label={label}
        value={String(predicate.value)}
        items={[
          { value: 'true', label: t('rules.checked') },
          { value: 'false', label: t('rules.unchecked') },
        ]}
        onChange={(value) =>
          props.onChange({ ...predicate, value: value === 'true' } as Predicate)
        }
      />
    );
  }
  if (field.options) {
    return (
      <Choice
        id={props.id}
        label={label}
        value={String(predicate.value)}
        items={field.options}
        onChange={(value) =>
          props.onChange({ ...predicate, value } as Predicate)
        }
      />
    );
  }
  return (
    <Field>
      <FieldLabel htmlFor={props.id}>{label}</FieldLabel>
      <Input
        id={props.id}
        type={numeric ? 'number' : field.type === 'date' ? 'date' : 'text'}
        step={field.type === 'decimal' ? 'any' : undefined}
        value={String(predicate.value)}
        onChange={(event) =>
          props.onChange({
            ...predicate,
            value: numeric ? Number(event.target.value) : event.target.value,
          } as Predicate)
        }
      />
    </Field>
  );
}

/** A labelled select of a few items. */
function Choice(props: {
  id: string;
  label: string;
  value: string;
  items: readonly { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <Field>
      <FieldLabel htmlFor={props.id}>{props.label}</FieldLabel>
      <Select
        items={props.items}
        value={props.value}
        onValueChange={(value) => value !== null && props.onChange(value)}
      >
        <SelectTrigger id={props.id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {props.items.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}
