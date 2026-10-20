import { isApiError } from '@nestjs-monorepo-template/api-client';
import { Button } from '@nestjs-monorepo-template/ui/components/button';
import { Input } from '@nestjs-monorepo-template/ui/components/input';
import { Checkbox } from '@nestjs-monorepo-template/ui/components/checkbox';
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
  FieldGroup,
  FieldLabel,
} from '@nestjs-monorepo-template/ui/components/field';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@nestjs-monorepo-template/ui/components/select';
import { useQuery } from '@tanstack/react-query';
import { PlusIcon, XIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { applyFieldErrors, errorMessage } from '@/lib/errors';
import { FormAlert, useAppForm } from '@/lib/form';
import {
  DATE_PARTS,
  namingVariablesQuery,
  type NamingCondition,
  type NamingField,
  type NamingSeries,
  type NumberedSubject,
} from '@/lib/naming-series';
import { z } from '@/lib/zod';
import { previewQuery, useCreateSeries, useUpdateSeries } from './api';

/**
 * The schema's limits (`POST /v1/naming-series`). What a pattern may hold
 * (fields, variables, date parts) is the API's to judge: its 400 is shown.
 */
const LIMITS = { pattern: 60, label: 100, conditions: 10 } as const;

/** "Date from" when the series dates its numbers from the moment of creation. */
const CREATED = '*';

const OPERATORS = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte'] as const;
const OPERATOR_SYMBOL: Record<NamingCondition['op'], string> = {
  eq: '=',
  ne: '≠',
  gt: '>',
  gte: '≥',
  lt: '<',
  lte: '≤',
};

/** A condition as the form holds it: the value is what the input shows. */
type ConditionRow = { field: string; op: NamingCondition['op']; value: string };

const toRow = (c: NamingCondition): ConditionRow => ({
  field: c.field,
  op: c.op,
  value: String(c.value),
});

/** The value the API takes, typed by the field's kind; undefined if empty. */
function conditionValue(
  row: ConditionRow,
  fields: NamingField[],
): string | number | boolean | undefined {
  if (!row.field || row.value.trim() === '') return undefined;
  const kind = fields.find((f) => f.name === row.field)?.kind;
  if (kind === 'number') {
    const n = Number(row.value);
    return Number.isFinite(n) ? n : undefined;
  }
  if (kind === 'boolean') return row.value === 'true';
  return row.value.trim();
}

/** How long a pattern rests before the API is asked what it would give. */
const PREVIEW_DELAY_MS = 300;

/**
 * The next number a pattern gives (`POST /v1/naming-series/preview`), asked
 * once the user stops typing. An invalid pattern is a 400: its message is
 * shown to the user as the API wrote it.
 */
function Preview(props: {
  subject: string;
  pattern: string;
  dateField?: string;
}) {
  const { t } = useTranslation('naming-series');
  const [settled, setSettled] = useState(props.pattern.trim());
  useEffect(() => {
    const timer = setTimeout(
      () => setSettled(props.pattern.trim()),
      PREVIEW_DELAY_MS,
    );
    return () => clearTimeout(timer);
  }, [props.pattern]);
  const preview = useQuery({
    ...previewQuery(props.subject, settled, { dateField: props.dateField }),
    enabled: !!props.subject && !!settled,
  });
  const waiting = props.pattern.trim() !== settled || preview.isFetching;
  return (
    <p role="status" className="text-sm text-muted-foreground">
      {!props.pattern.trim() || !props.subject ? (
        t('form.previewEmpty')
      ) : preview.isError && !waiting ? (
        <span className="text-destructive">{errorMessage(preview.error)}</span>
      ) : preview.isSuccess && !waiting ? (
        t('form.previewNext', { next: preview.data.next })
      ) : (
        t('form.previewLoading')
      )}
    </p>
  );
}

/** A part of a pattern, clickable to add it at the end of the pattern. */
function PartButton(props: { part: string; onInsert: (part: string) => void }) {
  const { t } = useTranslation('naming-series');
  return (
    <Button
      type="button"
      variant="outline"
      size="xs"
      className="font-mono"
      aria-label={t('form.insert', { part: props.part })}
      onClick={() => props.onInsert(props.part)}
    >
      {props.part}
    </Button>
  );
}

/**
 * What a pattern may hold, as Frappe's naming rule help lists it: the
 * subject's fields, the variables (`GET /v1/naming-series/variables`) and the
 * date parts. Each adds itself to the pattern.
 */
function Parts(props: {
  fields: NamingField[];
  onInsert: (part: string) => void;
}) {
  const { t } = useTranslation('naming-series');
  const variables = useQuery({
    ...namingVariablesQuery,
    meta: { errorToast: false },
  });
  const printable = props.fields.filter((f) => f.kind !== 'boolean');
  const groups = [
    {
      title: t('form.partsFields'),
      parts: printable.map((f) => ({ part: `{${f.name}}`, hint: f.kind })),
    },
    {
      title: t('form.partsVariables'),
      parts: (variables.data ?? []).map((v) => ({
        part: `{${v.name}}`,
        hint: v.description,
      })),
    },
    {
      title: t('form.partsDates'),
      parts: DATE_PARTS.map((part) => ({ part, hint: undefined })),
    },
  ].filter((g) => g.parts.length > 0);
  return (
    <div className="flex flex-col gap-2 rounded-md border p-3 text-sm">
      <p className="text-xs text-muted-foreground">{t('form.partsHint')}</p>
      {groups.map((g) => (
        <div key={g.title} className="flex flex-col gap-1">
          <span className="text-xs font-medium">{g.title}</span>
          <div className="flex flex-wrap gap-1">
            {g.parts.map((p) => (
              <span key={p.part} title={p.hint}>
                <PartButton part={p.part} onInsert={props.onInsert} />
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** The conditions of a series: rows of field, operator and value. */
function ConditionsEditor(props: {
  fields: NamingField[];
  rows: ConditionRow[];
  onChange: (rows: ConditionRow[]) => void;
}) {
  const { t } = useTranslation('naming-series');
  const { fields, rows } = props;
  const change = (index: number, patch: Partial<ConditionRow>) =>
    props.onChange(rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  return (
    <div className="flex flex-col gap-2">
      {rows.map((row, index) => {
        const n = index + 1;
        const kind = fields.find((f) => f.name === row.field)?.kind;
        const operators =
          kind === 'boolean' ? (['eq', 'ne'] as const) : OPERATORS;
        return (
          <div key={index} className="flex flex-wrap items-center gap-2">
            <Select
              items={fields.map((f) => ({ value: f.name, label: f.name }))}
              value={row.field || null}
              onValueChange={(next) => {
                if (!next) return;
                const nextKind = fields.find((f) => f.name === next)?.kind;
                change(index, {
                  field: next,
                  value: nextKind === 'boolean' ? 'true' : '',
                  op: nextKind === 'boolean' ? 'eq' : row.op,
                });
              }}
            >
              <SelectTrigger
                className="w-36"
                aria-label={t('form.conditionField', { n })}
              >
                <SelectValue
                  placeholder={t('form.conditionFieldPlaceholder')}
                />
              </SelectTrigger>
              <SelectContent>
                {fields.map((f) => (
                  <SelectItem key={f.name} value={f.name}>
                    {f.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              items={operators.map((op) => ({
                value: op,
                label: OPERATOR_SYMBOL[op],
              }))}
              value={row.op}
              onValueChange={(next) =>
                next && change(index, { op: next as ConditionRow['op'] })
              }
            >
              <SelectTrigger
                className="w-20"
                aria-label={t('form.conditionOp', { n })}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {operators.map((op) => (
                  <SelectItem key={op} value={op}>
                    {OPERATOR_SYMBOL[op]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {kind === 'boolean' ? (
              <Select
                items={[
                  { value: 'true', label: t('form.yes') },
                  { value: 'false', label: t('form.no') },
                ]}
                value={row.value || 'true'}
                onValueChange={(next) => next && change(index, { value: next })}
              >
                <SelectTrigger
                  className="w-24"
                  aria-label={t('form.conditionValue', { n })}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="true">{t('form.yes')}</SelectItem>
                  <SelectItem value="false">{t('form.no')}</SelectItem>
                </SelectContent>
              </Select>
            ) : (
              <Input
                className="w-36"
                type={kind === 'number' ? 'number' : 'text'}
                value={row.value}
                aria-label={t('form.conditionValue', { n })}
                onChange={(event) =>
                  change(index, { value: event.target.value })
                }
              />
            )}
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t('form.conditionRemove', { n })}
              onClick={() => props.onChange(rows.filter((_, i) => i !== index))}
            >
              <XIcon />
            </Button>
          </div>
        );
      })}
      <div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={rows.length >= LIMITS.conditions || fields.length === 0}
          onClick={() =>
            props.onChange([...rows, { field: '', op: 'eq', value: '' }])
          }
        >
          <PlusIcon />
          {t('form.conditionAdd')}
        </Button>
      </div>
    </div>
  );
}

/**
 * Create a series (no `series`) or change one (docs/sequences.md): its
 * pattern, label, and, on creation, whether it is the subject's default.
 * Only what changed is sent. A pattern the subject already has is a 409 shown
 * on the field; an invalid one a 400 with the field's message.
 */
export function SeriesDialog(props: {
  series?: NamingSeries;
  subjects: NumberedSubject[];
  /** The subject a new series starts with. */
  subject?: string;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation('naming-series');
  const { series, subjects } = props;
  const create = useCreateSeries();
  const update = useUpdateSeries();
  const [error, setError] = useState<string>();

  const form = useAppForm({
    defaultValues: {
      subject: series?.subject ?? props.subject ?? subjects[0]?.subject ?? '',
      pattern: series?.pattern ?? '',
      label: series?.label ?? '',
      isDefault: false,
      dateField: series?.dateField ?? CREATED,
      conditions: (series?.conditions ?? []).map(toRow),
      priority: String(series?.priority ?? 0),
    },
    onSubmit: async ({ value }) => {
      setError(undefined);
      const pattern = value.pattern.trim();
      const label = value.label.trim();
      const fields =
        subjects.find((s) => s.subject === value.subject)?.fields ?? [];
      const conditions: NamingCondition[] = [];
      for (const row of value.conditions) {
        const typed = conditionValue(row, fields);
        if (typed === undefined) {
          setError(t('form.conditionIncomplete'));
          return;
        }
        conditions.push({ field: row.field, op: row.op, value: typed });
      }
      const priority = Number(value.priority);
      if (value.priority.trim() === '' || !Number.isInteger(priority)) {
        setError(t('form.priorityInvalid'));
        return;
      }
      const dateField = value.dateField === CREATED ? null : value.dateField;
      try {
        if (series) {
          const changes: {
            pattern?: string;
            label?: string | null;
            dateField?: string | null;
            conditions?: NamingCondition[];
            priority?: number;
          } = {};
          if (pattern !== series.pattern) changes.pattern = pattern;
          if (label !== (series.label ?? '')) changes.label = label || null;
          if (dateField !== series.dateField) changes.dateField = dateField;
          if (
            JSON.stringify(conditions) !== JSON.stringify(series.conditions)
          ) {
            changes.conditions = conditions;
          }
          if (priority !== series.priority) changes.priority = priority;
          if (Object.keys(changes).length === 0) {
            props.onOpenChange(false);
            return;
          }
          await update.mutateAsync({ id: series.id, changes });
          toast.success(t('updated', { pattern }));
        } else {
          await create.mutateAsync({
            subject: value.subject,
            pattern,
            ...(label && { label }),
            ...(value.isDefault && { isDefault: true }),
            ...(dateField && { dateField }),
            ...(conditions.length > 0 && { conditions }),
            ...(priority !== 0 && { priority }),
          });
          toast.success(t('created', { pattern }));
        }
        props.onOpenChange(false);
      } catch (caught) {
        if (isApiError(caught) && caught.status === 409) {
          form.setFieldMeta('pattern', (meta) => ({
            ...meta,
            isTouched: true,
            errorMap: {
              ...meta?.errorMap,
              onSubmit: {
                message: t('form.patternTaken', {
                  pattern,
                  subject: value.subject,
                }),
              },
            },
          }));
        } else if (!applyFieldErrors(form, caught)) {
          setError(errorMessage(caught));
        }
      }
    },
  });

  return (
    <Dialog open onOpenChange={props.onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {series ? t('form.editTitle') : t('form.createTitle')}
          </DialogTitle>
          <DialogDescription>{t('form.syntax')}</DialogDescription>
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
            <form.Field name="subject">
              {(f) => (
                <Field>
                  <FieldLabel htmlFor="series-subject">
                    {t('form.subject')}
                  </FieldLabel>
                  <Select
                    items={subjects.map((s) => ({
                      value: s.subject,
                      label: s.subject,
                    }))}
                    value={f.state.value}
                    disabled={!!series}
                    onValueChange={(next) => {
                      if (!next) return;
                      f.handleChange(next);
                      // The fields belong to the subject.
                      form.setFieldValue('dateField', CREATED);
                      form.setFieldValue('conditions', []);
                    }}
                  >
                    <SelectTrigger id="series-subject" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {subjects.map((s) => (
                        <SelectItem key={s.subject} value={s.subject}>
                          {s.subject}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              )}
            </form.Field>
            <form.AppField
              name="pattern"
              validators={{
                onSubmit: z
                  .string()
                  .trim()
                  .min(1, t('form.patternRequired'))
                  .max(LIMITS.pattern, t('form.patternTooLong')),
              }}
            >
              {(f) => (
                <f.TextField
                  label={t('form.pattern')}
                  placeholder="INV-.YYYY.-.MM.-.#####"
                  description={t('form.patternHint')}
                  autoFocus
                />
              )}
            </form.AppField>
            <form.Subscribe selector={(state) => state.values.subject}>
              {(subject) => (
                <Parts
                  fields={
                    subjects.find((s) => s.subject === subject)?.fields ?? []
                  }
                  onInsert={(part) => {
                    const current = form.getFieldValue('pattern').trim();
                    form.setFieldValue(
                      'pattern',
                      current && !current.endsWith('.')
                        ? `${current}.${part}`
                        : `${current}${part}`,
                    );
                  }}
                />
              )}
            </form.Subscribe>
            <form.Subscribe selector={(state) => state.values}>
              {(values) => (
                <Preview
                  subject={values.subject}
                  pattern={values.pattern}
                  dateField={
                    values.dateField === CREATED ? undefined : values.dateField
                  }
                />
              )}
            </form.Subscribe>
            <form.Subscribe selector={(state) => state.values.subject}>
              {(subject) => {
                const dates = (
                  subjects.find((s) => s.subject === subject)?.fields ?? []
                ).filter((f) => f.kind === 'date' || f.kind === 'datetime');
                return (
                  <form.Field name="dateField">
                    {(f) => (
                      <Field>
                        <FieldLabel htmlFor="series-date-field">
                          {t('form.dateField')}
                        </FieldLabel>
                        <Select
                          items={[
                            { value: CREATED, label: t('form.dateFieldNow') },
                            ...dates.map((d) => ({
                              value: d.name,
                              label: d.name,
                            })),
                          ]}
                          value={f.state.value}
                          onValueChange={(next) => next && f.handleChange(next)}
                        >
                          <SelectTrigger
                            id="series-date-field"
                            className="w-full"
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value={CREATED}>
                              {t('form.dateFieldNow')}
                            </SelectItem>
                            {dates.map((d) => (
                              <SelectItem key={d.name} value={d.name}>
                                {d.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <FieldDescription>
                          {t('form.dateFieldHint')}
                        </FieldDescription>
                      </Field>
                    )}
                  </form.Field>
                );
              }}
            </form.Subscribe>
            <form.AppField
              name="label"
              validators={{
                onSubmit: z.string().max(LIMITS.label, t('form.labelTooLong')),
              }}
            >
              {(f) => (
                <f.TextField
                  label={t('form.label')}
                  description={t('form.labelHint')}
                />
              )}
            </form.AppField>
            <form.Subscribe selector={(state) => state.values.subject}>
              {(subject) => (
                <form.Field name="conditions">
                  {(f) => (
                    <Field>
                      <FieldLabel>{t('form.conditions')}</FieldLabel>
                      <ConditionsEditor
                        fields={
                          subjects.find((s) => s.subject === subject)?.fields ??
                          []
                        }
                        rows={f.state.value}
                        onChange={f.handleChange}
                      />
                      <FieldDescription>
                        {t('form.conditionsHint')}
                      </FieldDescription>
                    </Field>
                  )}
                </form.Field>
              )}
            </form.Subscribe>
            <form.Field name="priority">
              {(f) => (
                <Field>
                  <FieldLabel htmlFor="series-priority">
                    {t('form.priority')}
                  </FieldLabel>
                  <Input
                    id="series-priority"
                    type="number"
                    step={1}
                    inputMode="numeric"
                    value={f.state.value}
                    onChange={(event) => f.handleChange(event.target.value)}
                  />
                  <FieldDescription>{t('form.priorityHint')}</FieldDescription>
                </Field>
              )}
            </form.Field>
            {!series && (
              <form.Field name="isDefault">
                {(f) => (
                  <Field orientation="horizontal">
                    <Checkbox
                      id="series-default"
                      checked={f.state.value}
                      onCheckedChange={(checked) => f.handleChange(!!checked)}
                    />
                    <FieldLabel htmlFor="series-default">
                      {t('form.makeDefault')}
                    </FieldLabel>
                  </Field>
                )}
              </form.Field>
            )}
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
              <form.SubmitButton>{t('form.save')}</form.SubmitButton>
            </form.AppForm>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
