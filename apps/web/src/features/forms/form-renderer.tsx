import { Checkbox } from '@nestjs-monorepo-template/ui/components/checkbox';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '@nestjs-monorepo-template/ui/components/field';
import { Input } from '@nestjs-monorepo-template/ui/components/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@nestjs-monorepo-template/ui/components/select';
import { Textarea } from '@nestjs-monorepo-template/ui/components/textarea';
import { useTranslation } from 'react-i18next';
import { useDescribedBy } from '@/lib/form';
import type { FormDefinition, FormField } from './api';
import { walkForm } from './rules';

/** What an input holds while the person types: text, a checkbox, choices. */
export type AnswerDraft = string | boolean | string[] | undefined;
export type AnswerDrafts = Record<string, AnswerDraft>;

/** The drafts a definition starts with: its fields' defaults. */
export function initialDrafts(definition: FormDefinition): AnswerDrafts {
  return Object.fromEntries(
    definition.sections.flatMap((section) =>
      section.fields.map((field) => [field.key, draftOf(field, field.default)]),
    ),
  );
}

const draftOf = (field: FormField, value: unknown): AnswerDraft => {
  if (value === undefined || value === null) {
    return field.type === 'checkbox' ? false : undefined;
  }
  if (field.type === 'checkbox') return value === true;
  if (field.type === 'multiSelect') {
    return Array.isArray(value) ? value.map(String) : [];
  }
  return String(value);
};

const isEmpty = (draft: AnswerDraft) =>
  draft === undefined ||
  draft === '' ||
  (Array.isArray(draft) && draft.length === 0);

/**
 * A draft as the server reads it (numbers as numbers, text trimmed, the
 * default when left empty); undefined: none, or not valid.
 */
const valueOf = (field: FormField, given: AnswerDraft): unknown => {
  const draft =
    isEmpty(given) && field.default !== undefined
      ? draftOf(field, field.default)
      : given;
  if (field.type === 'checkbox') return draft === true;
  if (isEmpty(draft)) return undefined;
  if (field.type === 'integer' || field.type === 'decimal') {
    const number = Number(draft);
    return Number.isNaN(number) ||
      (field.type === 'integer' && !Number.isInteger(number))
      ? undefined
      : number;
  }
  return typeof draft === 'string' ? draft.trim() : draft;
};

/**
 * What shows and what is required now, by the definition's conditions
 * (rules.ts, the server's own pass): the renderer draws only these.
 */
export function stateOf(definition: FormDefinition, drafts: AnswerDrafts) {
  const required = new Set<string>();
  const { visible } = walkForm(definition.sections, (field, needed) => {
    if (needed) required.add(field.key);
    return valueOf(field, drafts[field.key]);
  });
  return { visible, required };
}

/**
 * The answers to send, and the problems the browser can tell already
 * (a required answer missing, a number that isn't one), by `answers.<key>`:
 * the server checks everything again against the published version. A
 * field its conditions hide is left out (the server would strip it).
 */
export function answersOf(
  definition: FormDefinition,
  drafts: AnswerDrafts,
  messages: { required: string; number: string },
): { answers: Record<string, unknown>; errors: Record<string, string> } {
  const answers: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  walkForm(definition.sections, (field, required) => {
    const draft = drafts[field.key];
    const path = `answers.${field.key}`;
    const value = valueOf(field, draft);
    if (field.type === 'checkbox') {
      if (required && draft !== true) errors[path] = messages.required;
      answers[field.key] = value;
      return value;
    }
    if (isEmpty(draft)) {
      if (required) errors[path] = messages.required;
      return undefined;
    }
    if (value === undefined) {
      errors[path] = messages.number;
      return undefined;
    }
    answers[field.key] =
      field.type === 'integer' || field.type === 'decimal' ? value : draft;
    return value;
  });
  return { answers, errors };
}

/**
 * A form's definition as inputs (docs/forms.md): its sections, each field
 * of its type, labelled, with its help and its error at `answers.<key>`.
 * Controlled: the caller holds the drafts. A preview in the builder and the
 * page people fill in draw it the same way.
 */
export function FormRenderer(props: {
  definition: FormDefinition;
  value: AnswerDrafts;
  onChange: (key: string, draft: AnswerDraft) => void;
  errors?: Record<string, string>;
  idPrefix?: string;
}) {
  const { visible, required } = stateOf(props.definition, props.value);
  return (
    <div className="flex flex-col gap-8">
      {props.definition.sections.map((section) => (
        <FieldSet
          key={section.key}
          hidden={!section.fields.some((field) => visible.has(field.key))}
        >
          {section.title && (
            <FieldLegend className="text-base font-medium">
              {section.title}
            </FieldLegend>
          )}
          {section.description && (
            <FieldDescription>{section.description}</FieldDescription>
          )}
          <div className="flex flex-col gap-4">
            {section.fields
              .filter((field) => visible.has(field.key))
              .map((field) => (
                <AnswerInput
                  key={field.key}
                  field={{ ...field, required: required.has(field.key) }}
                  idPrefix={props.idPrefix ?? 'form'}
                  draft={props.value[field.key]}
                  onChange={(draft) => props.onChange(field.key, draft)}
                  error={props.errors?.[`answers.${field.key}`]}
                />
              ))}
          </div>
        </FieldSet>
      ))}
    </div>
  );
}

const inputType: Partial<Record<FormField['type'], string>> = {
  email: 'email',
  url: 'url',
  integer: 'number',
  decimal: 'number',
  // Its value is the API's `YYYY-MM-DD`, with no time zone.
  date: 'date',
};

function AnswerInput(props: {
  field: FormField;
  idPrefix: string;
  draft: AnswerDraft;
  onChange: (draft: AnswerDraft) => void;
  error?: string;
}) {
  const { t } = useTranslation('forms');
  const { field, draft, error } = props;
  const invalid = !!error;
  const messages = error ? [{ message: error }] : undefined;
  const label = `${field.label}${field.required ? ' *' : ''}`;
  const { controlId, descriptionId, errorId, describedBy } = useDescribedBy(
    Boolean(field.help),
    invalid,
  );
  const id = `${props.idPrefix}-${controlId}`;
  const options = field.options ?? [];
  const help = field.help && (
    <FieldDescription id={descriptionId}>{field.help}</FieldDescription>
  );

  if (field.type === 'multiSelect' || field.type === 'radio') {
    const chosen = Array.isArray(draft)
      ? draft
      : typeof draft === 'string'
        ? [draft]
        : [];
    return (
      <FieldSet data-invalid={invalid} aria-describedby={describedBy}>
        <FieldLegend variant="label">{label}</FieldLegend>
        {help}
        <div
          className="flex flex-col gap-2"
          role={field.type === 'radio' ? 'radiogroup' : undefined}
          aria-label={field.type === 'radio' ? field.label : undefined}
        >
          {options.map((option) => (
            <Field key={option.value} orientation="horizontal">
              {field.type === 'radio' ? (
                // A native radio: one choice of a few, by the keyboard as
                // the browser does it (no radio group in packages/ui).
                <input
                  type="radio"
                  id={`${id}-${option.value}`}
                  name={id}
                  className="size-4 accent-primary"
                  checked={chosen.includes(option.value)}
                  onChange={() => props.onChange(option.value)}
                />
              ) : (
                <Checkbox
                  id={`${id}-${option.value}`}
                  checked={chosen.includes(option.value)}
                  aria-invalid={invalid}
                  onCheckedChange={(checked) =>
                    props.onChange(
                      checked
                        ? [...chosen, option.value]
                        : chosen.filter((value) => value !== option.value),
                    )
                  }
                />
              )}
              <FieldLabel htmlFor={`${id}-${option.value}`}>
                {option.label}
              </FieldLabel>
            </Field>
          ))}
        </div>
        {invalid && <FieldError id={errorId} errors={messages} />}
      </FieldSet>
    );
  }

  if (field.type === 'checkbox') {
    return (
      <Field orientation="horizontal" data-invalid={invalid}>
        <Checkbox
          id={id}
          checked={draft === true}
          aria-invalid={invalid}
          aria-describedby={describedBy}
          onCheckedChange={(checked) => props.onChange(checked === true)}
        />
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        {help}
        {invalid && <FieldError id={errorId} errors={messages} />}
      </Field>
    );
  }

  const text = typeof draft === 'string' ? draft : '';
  return (
    <Field data-invalid={invalid}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      {field.type === 'select' ? (
        <Select
          items={[
            ...(field.required ? [] : [{ value: NONE, label: t('none') }]),
            ...options,
          ]}
          value={text || (field.required ? null : NONE)}
          onValueChange={(value) =>
            props.onChange(value === NONE || value === null ? undefined : value)
          }
        >
          <SelectTrigger
            id={id}
            className="w-full"
            aria-invalid={invalid}
            aria-describedby={describedBy}
          >
            <SelectValue placeholder={field.placeholder ?? t('choose')} />
          </SelectTrigger>
          <SelectContent>
            {!field.required && (
              <SelectItem value={NONE}>{t('none')}</SelectItem>
            )}
            {options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : field.type === 'textarea' ? (
        <Textarea
          id={id}
          rows={4}
          value={text}
          placeholder={field.placeholder}
          aria-invalid={invalid}
          aria-describedby={describedBy}
          onChange={(event) => props.onChange(event.target.value)}
        />
      ) : (
        <Input
          id={id}
          type={inputType[field.type] ?? 'text'}
          step={field.type === 'decimal' ? 'any' : undefined}
          value={text}
          placeholder={field.placeholder}
          aria-invalid={invalid}
          aria-describedby={describedBy}
          onChange={(event) => props.onChange(event.target.value)}
        />
      )}
      {help}
      {invalid && <FieldError id={errorId} errors={messages} />}
    </Field>
  );
}

/** The "no answer" item of an optional select. */
const NONE = '__none';
