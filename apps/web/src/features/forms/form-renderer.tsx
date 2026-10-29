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
import { Button } from '@nestjs-monorepo-template/ui/components/button';
import { Textarea } from '@nestjs-monorepo-template/ui/components/textarea';
import { Skeleton } from '@nestjs-monorepo-template/ui/components/skeleton';
import { useQuery } from '@tanstack/react-query';
import { PlusIcon, TrashIcon } from 'lucide-react';
import { useDeferredValue, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDescribedBy } from '@/lib/form';
import {
  type FormDefinition,
  type FormField,
  type FormSection,
  type GroupField,
  sourceOptionsQuery,
} from './api';
import { walkForm } from './rules';

/** What an input holds while the person types: text, a checkbox, choices. */
type FieldDraft = string | boolean | string[] | undefined;
/**
 * One item of a repeatable group as it is filled in: a stable `id` (its
 * inputs' key, so removing an item never moves another's answers) and its
 * fields' drafts.
 */
export interface GroupItemDraft {
  id: string;
  drafts: Record<string, FieldDraft>;
}
export type AnswerDraft = FieldDraft | GroupItemDraft[];
export type AnswerDrafts = Record<string, AnswerDraft>;

/** The most items of a group, whatever its `maxItems` (the API's FORM_LIMITS.groupItems). */
export const GROUP_ITEMS_LIMIT = 50;

/** The pages of a definition: runs of sections, a new one at each `startsPage` (form-schema.ts, pagesOf). */
export function pagesOf(sections: readonly FormSection[]): FormSection[][] {
  const pages: FormSection[][] = [];
  for (const section of sections) {
    if (pages.length === 0 || section.startsPage) pages.push([]);
    pages.at(-1)!.push(section);
  }
  return pages;
}

let items = 0;
/** A group's new item: its fields' defaults. */
export const newItem = (field: FormField): GroupItemDraft => ({
  id: `item-${++items}`,
  drafts: Object.fromEntries(
    (field.fields ?? []).map((sub) => [sub.key, draftOf(sub, sub.default)]),
  ),
});

/** The drafts a definition starts with: its fields' defaults, a group's `minItems` items. */
export function initialDrafts(definition: FormDefinition): AnswerDrafts {
  return Object.fromEntries(
    definition.sections.flatMap((section) =>
      section.fields.map((field) => [
        field.key,
        field.type === 'group'
          ? Array.from({ length: field.validation?.minItems ?? 0 }, () =>
              newItem(field),
            )
          : draftOf(field, field.default),
      ]),
    ),
  );
}

function draftOf(field: FormField | GroupField, value: unknown): FieldDraft {
  if (value === undefined || value === null) {
    return field.type === 'checkbox' ? false : undefined;
  }
  if (field.type === 'checkbox') return value === true;
  if (field.type === 'multiSelect') {
    return Array.isArray(value) ? value.map(String) : [];
  }
  return String(value);
}

const isEmpty = (draft: AnswerDraft) =>
  draft === undefined ||
  draft === '' ||
  (Array.isArray(draft) && draft.length === 0);

/**
 * A draft as the server reads it (numbers as numbers, text trimmed, the
 * default when left empty); undefined: none, or not valid.
 */
const valueOf = (
  field: FormField | GroupField,
  given: AnswerDraft,
): unknown => {
  if (field.type === 'group') {
    const list = Array.isArray(given) ? (given as GroupItemDraft[]) : [];
    return list.length === 0
      ? undefined
      : list.map((item) =>
          Object.fromEntries(
            (field.fields ?? []).map((sub) => [
              sub.key,
              valueOf(sub, item.drafts[sub.key]),
            ]),
          ),
        );
  }
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

export interface AnswerMessages {
  required: string;
  number: string;
  minItems: (count: number) => string;
  maxItems: (count: number) => string;
}

/**
 * One field's answer to send (undefined: none), its problem at `path` in
 * `errors`. A group's is its items', each checked at `<path>.<index>.<key>`.
 */
function answerOf(
  field: FormField | GroupField,
  draft: AnswerDraft,
  required: boolean,
  path: string,
  errors: Record<string, string>,
  messages: AnswerMessages,
): unknown {
  if (field.type === 'group') {
    const list = Array.isArray(draft) ? (draft as GroupItemDraft[]) : [];
    const min = field.validation?.minItems ?? 0;
    const max = Math.min(
      field.validation?.maxItems ?? GROUP_ITEMS_LIMIT,
      GROUP_ITEMS_LIMIT,
    );
    if (list.length === 0) {
      if (required) errors[path] = messages.required;
      return undefined;
    }
    if (list.length < min) errors[path] = messages.minItems(min);
    if (list.length > max) errors[path] = messages.maxItems(max);
    return list.map((item, index) => {
      const answer: Record<string, unknown> = {};
      for (const sub of field.fields ?? []) {
        const value = answerOf(
          sub,
          item.drafts[sub.key],
          sub.required === true,
          `${path}.${index}.${sub.key}`,
          errors,
          messages,
        );
        if (value !== undefined) answer[sub.key] = value;
      }
      return answer;
    });
  }
  const value = valueOf(field, draft);
  if (field.type === 'checkbox') {
    if (required && draft !== true) errors[path] = messages.required;
    return value;
  }
  if (isEmpty(draft)) {
    if (required) errors[path] = messages.required;
    return undefined;
  }
  if (value === undefined) errors[path] = messages.number;
  return value;
}

/**
 * The answers to send, and the problems the browser can tell already
 * (a required answer missing, a number that isn't one, a group's number of
 * items), by `answers.<key>` (`answers.<group>.<index>.<key>` in a group):
 * the server checks everything again against the published version. A
 * field its conditions hide is left out (the server would strip it).
 */
export function answersOf(
  definition: FormDefinition,
  drafts: AnswerDrafts,
  messages: AnswerMessages,
): { answers: Record<string, unknown>; errors: Record<string, string> } {
  const answers: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  walkForm(definition.sections, (field, required) => {
    const value = answerOf(
      field,
      drafts[field.key],
      required,
      `answers.${field.key}`,
      errors,
      messages,
    );
    if (value !== undefined) answers[field.key] = value;
    // What the conditions after it read: its default too (as the server does).
    return valueOf(field, drafts[field.key]);
  });
  return { answers, errors };
}

/**
 * A form's definition as inputs (docs/forms.md): its sections, each field
 * of its type, labelled, with its help and its error at `answers.<key>`.
 * Controlled: the caller holds the drafts. A preview in the builder and the
 * page people fill in draw it the same way; `page` draws one page of a
 * wizard (pagesOf), its conditions read from every answer. A field with an
 * option source reads its choices from the published form `formId`; in a
 * preview (no `formId`) it says where they will come from.
 */
export function FormRenderer(props: {
  definition: FormDefinition;
  formId?: string;
  value: AnswerDrafts;
  onChange: (key: string, draft: AnswerDraft) => void;
  errors?: Record<string, string>;
  idPrefix?: string;
  page?: number;
}) {
  const { visible, required } = stateOf(props.definition, props.value);
  const sections =
    props.page === undefined
      ? props.definition.sections
      : (pagesOf(props.definition.sections)[props.page] ?? []);
  return (
    <div className="flex flex-col gap-8">
      {sections.map((section) => (
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
              .map((field) =>
                field.type === 'group' ? (
                  <GroupInput
                    key={field.key}
                    field={{ ...field, required: required.has(field.key) }}
                    idPrefix={props.idPrefix ?? 'form'}
                    items={
                      Array.isArray(props.value[field.key])
                        ? (props.value[field.key] as GroupItemDraft[])
                        : []
                    }
                    onChange={(next) => props.onChange(field.key, next)}
                    errors={props.errors ?? {}}
                  />
                ) : field.optionsSource ? (
                  <SourcedInput
                    key={field.key}
                    formId={props.formId}
                    field={{ ...field, required: required.has(field.key) }}
                    idPrefix={props.idPrefix ?? 'form'}
                    draft={props.value[field.key] as FieldDraft}
                    onChange={(draft) => props.onChange(field.key, draft)}
                    error={props.errors?.[`answers.${field.key}`]}
                  />
                ) : (
                  <AnswerInput
                    key={field.key}
                    field={{ ...field, required: required.has(field.key) }}
                    idPrefix={props.idPrefix ?? 'form'}
                    draft={props.value[field.key] as FieldDraft}
                    onChange={(draft) => props.onChange(field.key, draft)}
                    error={props.errors?.[`answers.${field.key}`]}
                  />
                ),
              )}
          </div>
        </FieldSet>
      ))}
    </div>
  );
}

/**
 * A repeatable group: its items, each its fields' inputs (errors at
 * `answers.<group>.<index>.<key>`), added up to `maxItems` and removed
 * down to `minItems`. Removing one moves the focus to the add button.
 */
function GroupInput(props: {
  field: FormField;
  idPrefix: string;
  items: GroupItemDraft[];
  onChange: (items: GroupItemDraft[]) => void;
  errors: Record<string, string>;
}) {
  const { t } = useTranslation('forms');
  const { field, items } = props;
  const path = `answers.${field.key}`;
  const error = props.errors[path];
  const { descriptionId, errorId, describedBy } = useDescribedBy(
    Boolean(field.help),
    !!error,
  );
  const min = field.validation?.minItems ?? 0;
  const max = Math.min(
    field.validation?.maxItems ?? GROUP_ITEMS_LIMIT,
    GROUP_ITEMS_LIMIT,
  );
  const addId = `${props.idPrefix}-${field.key}-add`;
  return (
    <FieldSet data-invalid={!!error} aria-describedby={describedBy}>
      <FieldLegend variant="label">{`${field.label}${field.required ? ' *' : ''}`}</FieldLegend>
      {field.help && (
        <FieldDescription id={descriptionId}>{field.help}</FieldDescription>
      )}
      <ol className="flex flex-col gap-3">
        {items.map((item, index) => {
          const n = index + 1;
          return (
            <li key={item.id}>
              <FieldSet className="gap-3 rounded-md border p-3">
                <FieldLegend variant="label">
                  {t('group.item', { label: field.label, n })}
                </FieldLegend>
                {(field.fields ?? []).map((sub) => (
                  <AnswerInput
                    key={sub.key}
                    field={sub}
                    idPrefix={`${props.idPrefix}-${item.id}`}
                    draft={item.drafts[sub.key]}
                    onChange={(draft) =>
                      props.onChange(
                        items.map((other) =>
                          other.id === item.id
                            ? {
                                ...other,
                                drafts: { ...other.drafts, [sub.key]: draft },
                              }
                            : other,
                        ),
                      )
                    }
                    error={props.errors[`${path}.${index}.${sub.key}`]}
                  />
                ))}
                <div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={items.length <= min}
                    onClick={() => {
                      props.onChange(items.filter((other) => other !== item));
                      // After the render: the add button may be enabled only then.
                      requestAnimationFrame(() =>
                        document.getElementById(addId)?.focus(),
                      );
                    }}
                  >
                    <TrashIcon />
                    {t('group.remove', { label: field.label, n })}
                  </Button>
                </div>
              </FieldSet>
            </li>
          );
        })}
      </ol>
      <div>
        <Button
          id={addId}
          type="button"
          variant="outline"
          size="sm"
          disabled={items.length >= max}
          aria-invalid={!!error}
          onClick={() => props.onChange([...items, newItem(field)])}
        >
          <PlusIcon />
          {t('group.add', { label: field.label })}
        </Button>
      </div>
      {error && <FieldError id={errorId} errors={[{ message: error }]} />}
    </FieldSet>
  );
}

/**
 * A choice field whose choices come from its option source, through the
 * form (GET /v1/forms/{id}/options/{key}): a search box narrows them (the
 * server answers at most 20), the labels of what was chosen are kept while
 * searching, and a failure says so with a retry. Only values are sent.
 */
function SourcedInput(props: {
  formId?: string;
  field: FormField;
  idPrefix: string;
  draft: FieldDraft;
  onChange: (draft: FieldDraft) => void;
  error?: string;
}) {
  const { t } = useTranslation('forms');
  const { field } = props;
  const [search, setSearch] = useState('');
  const q = useDeferredValue(search.trim());
  const [labels, setLabels] = useState<Record<string, string>>({});
  const options = useQuery({
    ...sourceOptionsQuery(props.formId ?? '', field.key, q),
    enabled: props.formId !== undefined,
  });
  if (props.formId === undefined) {
    return (
      <Field>
        <FieldLabel>{field.label}</FieldLabel>
        <FieldDescription>{t('source.preview')}</FieldDescription>
      </Field>
    );
  }
  const items = options.data?.items ?? [];
  const chosen = (
    Array.isArray(props.draft)
      ? props.draft
      : typeof props.draft === 'string'
        ? [props.draft]
        : []
  ).filter((value) => !items.some((item) => item.value === value));
  const searchId = `${props.idPrefix}-${field.key}-search`;
  return (
    <div className="flex flex-col gap-2">
      <Field>
        <FieldLabel htmlFor={searchId} className="sr-only">
          {t('source.search', { label: field.label })}
        </FieldLabel>
        <Input
          id={searchId}
          type="search"
          value={search}
          placeholder={t('source.search', { label: field.label })}
          onChange={(event) => setSearch(event.target.value)}
        />
      </Field>
      {options.isPending ? (
        <Skeleton className="h-9 w-full" aria-busy />
      ) : options.isError ? (
        <div className="flex items-center gap-2">
          <p role="alert" className="text-sm text-destructive">
            {t('source.error', { label: field.label })}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void options.refetch()}
          >
            {t('source.retry')}
          </Button>
        </div>
      ) : (
        <>
          <AnswerInput
            field={{
              ...field,
              options: [
                ...chosen.map((value) => ({
                  value,
                  label: labels[value] ?? value,
                })),
                ...items,
              ],
            }}
            idPrefix={props.idPrefix}
            draft={props.draft}
            onChange={(draft) => {
              setLabels({
                ...labels,
                ...Object.fromEntries(
                  items.map((item) => [item.value, item.label]),
                ),
              });
              props.onChange(draft);
            }}
            error={props.error}
          />
          {options.data.hasMore && (
            <p className="text-sm text-muted-foreground">{t('source.more')}</p>
          )}
        </>
      )}
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
  field: FormField | GroupField;
  idPrefix: string;
  draft: FieldDraft;
  onChange: (draft: FieldDraft) => void;
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
