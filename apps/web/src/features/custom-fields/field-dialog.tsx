import { Button } from '@nestjs-monorepo-template/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@nestjs-monorepo-template/ui/components/dialog';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@nestjs-monorepo-template/ui/components/field';
import { Input } from '@nestjs-monorepo-template/ui/components/input';
import { Switch } from '@nestjs-monorepo-template/ui/components/switch';
import { PlusIcon, Trash2Icon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CustomFieldInputs } from '@/components/records/custom-field-inputs';
import { applyFieldErrors, errorMessage } from '@/lib/errors';
import { hasOptions, type CustomField } from '@/lib/custom-fields';
import { draftError } from '@/lib/custom-values';
import { FormAlert, useAppForm, useDescribedBy } from '@/lib/form';
import { z } from '@/lib/zod';
import { useCreateField, useUpdateField } from './api';
import {
  EMPTY_DEFINITION,
  FIELD_TYPES,
  KEY_PATTERN,
  LIMITS,
  changesBody,
  createBody,
  limitsOf,
  previewField,
  toValues,
  type DefinitionValues,
} from './definition';

/** Validators return plain strings; FieldError wants `{ message }`. */
const asMessages = (errors: readonly unknown[]) =>
  errors.map((error) =>
    typeof error === 'string'
      ? { message: error }
      : (error as { message?: string }),
  );

/**
 * One limit of the type (a bound or a length). A component, not a render
 * helper like the ones in the dialog, for its hook: what is wrong with the
 * limit describes the input (as lib/form.tsx's fields). Declared here, not
 * in the dialog, so the input stays mounted (focus) while the form changes.
 */
function LimitInput(props: {
  label: string;
  value: string;
  errors: readonly unknown[];
  onChange: (value: string) => void;
}) {
  const invalid = props.errors.length > 0;
  const { controlId, errorId, describedBy } = useDescribedBy(false, invalid);
  return (
    <Field data-invalid={invalid}>
      <FieldLabel htmlFor={controlId}>{props.label}</FieldLabel>
      <Input
        id={controlId}
        inputMode="decimal"
        value={props.value}
        aria-invalid={invalid}
        aria-describedby={describedBy}
        onChange={(event) => props.onChange(event.target.value)}
      />
      {invalid && <FieldError id={errorId} errors={asMessages(props.errors)} />}
    </Field>
  );
}

/**
 * Create (no `field`) or edit one definition of a subject: key (create
 * only: never changed), label, description, type, choices, required, a
 * default, the type's limits and whether lists filter and sort by it.
 * Edits send only what changed.
 */
export function FieldDialog(props: {
  subject: string;
  /** The field to edit; none: a new one. */
  field?: CustomField;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation('custom-fields');
  const { t: tRecords } = useTranslation('records');
  const { field } = props;
  const create = useCreateField(props.subject);
  const update = useUpdateField(props.subject);
  const [error, setError] = useState<string>();

  const form = useAppForm({
    defaultValues: field ? toValues(field) : EMPTY_DEFINITION,
    onSubmit: async ({ value }) => {
      setError(undefined);
      try {
        if (field) {
          const changes = changesBody(field, value);
          if (Object.keys(changes).length > 0) {
            await update.mutateAsync({ id: field.id, changes });
          }
        } else {
          await create.mutateAsync(createBody(props.subject, value));
        }
        props.onOpenChange(false);
      } catch (caught) {
        if (!applyFieldErrors(form, caught)) setError(errorMessage(caught));
      }
    },
  });

  // Render helpers, not components: they call no hooks, and as functions of
  // this render they keep their inputs mounted (focus) while the form changes.
  const toggle = (
    name: 'required' | 'filterable' | 'sortable',
    label: string,
    hint?: string,
  ) => (
    <form.Field name={name}>
      {(f) => (
        <Field orientation="horizontal">
          <Switch
            id={`field-${name}`}
            checked={f.state.value}
            onCheckedChange={(checked) => f.handleChange(checked)}
          />
          <div className="flex flex-col gap-1">
            <FieldLabel htmlFor={`field-${name}`}>{label}</FieldLabel>
            {hint && <FieldDescription>{hint}</FieldDescription>}
          </div>
        </Field>
      )}
    </form.Field>
  );

  /** The limits the type takes: values (number), counts (multiSelect), lengths and pattern (text types). */
  const limits = (type: DefinitionValues['type']) => {
    const { range, length } = limitsOf(type);
    if (!range && !length) return null;
    const names = range
      ? (['min', 'max'] as const)
      : (['minLength', 'maxLength'] as const);
    const labels = range
      ? type === 'number'
        ? (['min', 'max'] as const)
        : (['minChoices', 'maxChoices'] as const)
      : names;
    const check = (value: string, other: string, isMin: boolean) => {
      if (value.trim() === '') return undefined;
      const n = Number(value);
      if (!Number.isFinite(n)) return t('form.limitNumber');
      if (!range && (!Number.isInteger(n) || n < (isMin ? 0 : 1))) {
        return t('form.limitLength');
      }
      // Said once, on the lowest.
      if (isMin && other.trim() !== '' && n > Number(other)) {
        return t('form.limitOrder');
      }
      return undefined;
    };
    const input = (index: 0 | 1) => {
      const name = names[index];
      const otherName = names[1 - index] as typeof name;
      return (
        <form.Field
          key={name}
          name={name}
          validators={{
            onSubmit: ({ value, fieldApi }) =>
              check(value, fieldApi.form.getFieldValue(otherName), index === 0),
          }}
        >
          {(f) => (
            <LimitInput
              label={t(`form.${labels[index]}`)}
              value={f.state.value}
              errors={f.state.meta.errors}
              onChange={(next) => f.handleChange(next)}
            />
          )}
        </form.Field>
      );
    };
    return (
      <>
        <div className="grid grid-cols-2 gap-4">
          {input(0)}
          {input(1)}
        </div>
        {length && (
          <form.AppField name="pattern">
            {(f) => (
              <f.TextField
                label={t('form.pattern')}
                description={t('form.patternHint')}
              />
            )}
          </form.AppField>
        )}
      </>
    );
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {field
              ? t('form.editTitle', { label: field.label })
              : t('form.createTitle')}
          </DialogTitle>
          <DialogDescription>{t('form.description')}</DialogDescription>
        </DialogHeader>
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void form.handleSubmit();
          }}
        >
          <FieldGroup>
            <FormAlert message={error} />
            {field ? (
              <p className="text-sm text-muted-foreground">
                {t('form.key')}: <code>{field.key}</code>
              </p>
            ) : (
              <form.AppField
                name="key"
                validators={{
                  onSubmit: z.string().regex(KEY_PATTERN, t('form.keyInvalid')),
                }}
              >
                {(f) => (
                  <f.TextField
                    label={t('form.key')}
                    description={t('form.keyHint')}
                    autoFocus
                  />
                )}
              </form.AppField>
            )}
            <form.AppField
              name="label"
              validators={{
                onSubmit: z
                  .string()
                  .trim()
                  .min(1, t('form.labelRequired'))
                  .max(LIMITS.label, t('form.labelTooLong')),
              }}
            >
              {(f) => <f.TextField label={t('form.label')} />}
            </form.AppField>
            <form.AppField
              name="description"
              validators={{
                onSubmit: z.string().max(LIMITS.description, t('form.tooLong')),
              }}
            >
              {(f) => (
                <f.TextAreaField
                  label={t('form.descriptionLabel')}
                  description={t('form.descriptionHint')}
                  rows={2}
                />
              )}
            </form.AppField>
            <form.AppField name="type">
              {(f) => (
                <f.SelectField
                  label={t('form.type')}
                  options={FIELD_TYPES.map((type) => ({
                    value: type,
                    label: t(`types.${type}`),
                  }))}
                />
              )}
            </form.AppField>
            {field && (
              <p className="-mt-2 text-xs text-muted-foreground">
                {t('form.typeHint')}
              </p>
            )}
            <form.Subscribe selector={(state) => state.values.type}>
              {(type) =>
                hasOptions(type) && (
                  <form.Field
                    name="options"
                    validators={{
                      onSubmit: ({ value }) => optionsProblem(value, type, t),
                    }}
                  >
                    {(f) => {
                      const invalid = f.state.meta.errors.length > 0;
                      const rows = f.state.value;
                      const change = (
                        index: number,
                        part: Partial<{ value: string; label: string }>,
                      ) =>
                        f.handleChange(
                          rows.map((row, i) =>
                            i === index ? { ...row, ...part } : row,
                          ),
                        );
                      return (
                        <Field data-invalid={invalid}>
                          <FieldLabel>{t('form.options')}</FieldLabel>
                          <FieldDescription>
                            {t('form.optionsHint')}
                          </FieldDescription>
                          {rows.map((row, index) => (
                            <div
                              key={index}
                              className="flex items-center gap-2"
                            >
                              <Input
                                aria-label={t('form.optionValue', {
                                  n: index + 1,
                                })}
                                placeholder={t('form.optionValuePlaceholder')}
                                value={row.value}
                                maxLength={LIMITS.option}
                                onChange={(event) =>
                                  change(index, { value: event.target.value })
                                }
                              />
                              <Input
                                aria-label={t('form.optionLabel', {
                                  n: index + 1,
                                })}
                                placeholder={t('form.optionLabelPlaceholder')}
                                value={row.label}
                                maxLength={LIMITS.optionLabel}
                                onChange={(event) =>
                                  change(index, { label: event.target.value })
                                }
                              />
                              <Button
                                type="button"
                                variant="outline"
                                size="icon"
                                aria-label={t('form.removeOption', {
                                  n: index + 1,
                                })}
                                onClick={() =>
                                  f.handleChange(
                                    rows.filter((_, i) => i !== index),
                                  )
                                }
                              >
                                <Trash2Icon />
                              </Button>
                            </div>
                          ))}
                          <div>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() =>
                                f.handleChange([
                                  ...rows,
                                  { value: '', label: '' },
                                ])
                              }
                            >
                              <PlusIcon />
                              {t('form.addOption')}
                            </Button>
                          </div>
                          {invalid && (
                            <FieldError
                              errors={asMessages(f.state.meta.errors)}
                            />
                          )}
                        </Field>
                      );
                    }}
                  </form.Field>
                )
              }
            </form.Subscribe>
            <form.Subscribe selector={(state) => state.values.type}>
              {(type) => limits(type)}
            </form.Subscribe>
            <form.Subscribe selector={(state) => state.values}>
              {(values) => (
                <form.Field
                  name="default"
                  validators={{
                    onSubmit: ({ value }) =>
                      draftError(
                        previewField({ ...values, default: value }),
                        value,
                        tRecords,
                      ),
                  }}
                >
                  {(f) => (
                    <div className="flex flex-col gap-2">
                      <CustomFieldInputs
                        fields={[
                          {
                            ...previewField(values),
                            label: t('form.default'),
                            description: t('form.defaultHint'),
                          },
                        ]}
                        value={{ default: f.state.value }}
                        onChange={(_key, draft) => f.handleChange(draft)}
                        errors={
                          f.state.meta.errors.length > 0
                            ? {
                                default: String(
                                  asMessages(f.state.meta.errors)[0]?.message,
                                ),
                              }
                            : undefined
                        }
                      />
                      {f.state.value !== undefined &&
                        f.state.value !== '' &&
                        !(
                          Array.isArray(f.state.value) &&
                          f.state.value.length === 0
                        ) && (
                          <div>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() => f.handleChange(undefined)}
                            >
                              {t('form.clearDefault')}
                            </Button>
                          </div>
                        )}
                    </div>
                  )}
                </form.Field>
              )}
            </form.Subscribe>
            {toggle('required', t('form.required'))}
            {toggle(
              'filterable',
              t('form.filterable'),
              t('form.filterableHint'),
            )}
            {toggle('sortable', t('form.sortable'), t('form.sortableHint'))}
          </FieldGroup>
          <DialogFooter className="mt-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => props.onOpenChange(false)}
            >
              {t('form.cancel')}
            </Button>
            <form.AppForm>
              <form.SubmitButton>
                {field ? t('form.save') : t('form.create')}
              </form.SubmitButton>
            </form.AppForm>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function optionsProblem(
  rows: DefinitionValues['options'],
  type: string,
  t: (key: string) => string,
): string | undefined {
  if (rows.length === 0) return t('form.optionsRequired');
  const values = rows.map((row) => row.value.trim());
  if (rows.some((row) => !row.value.trim() || !row.label.trim())) {
    return t('form.optionIncomplete');
  }
  if (new Set(values).size !== values.length) return t('form.optionDuplicate');
  if (type === 'multiSelect' && values.some((value) => value.includes(','))) {
    return t('form.optionComma');
  }
  return undefined;
}
