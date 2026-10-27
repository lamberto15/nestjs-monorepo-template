import { Badge } from '@nestjs-monorepo-template/ui/components/badge';
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
import { Switch } from '@nestjs-monorepo-template/ui/components/switch';
import {
  TagsInput,
  TagsInputInput,
  TagsInputItem,
  TagsInputLabel,
  TagsInputList,
} from '@nestjs-monorepo-template/ui/components/tags-input';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { catalogQuery, type TransferFormat } from '@/features/transfer/api';
import { applyFieldErrors, errorMessage } from '@/lib/errors';
import { FormAlert, useAppForm } from '@/lib/form';
import { z } from '@/lib/zod';
import {
  REPORT_LIMITS,
  useCreateReport,
  useUpdateReport,
  type Report,
  type ReportCreate,
  type Schedule,
} from './api';
import {
  HOURS,
  MONTH_DAYS,
  WEEKDAYS,
  hourLabel,
  weekdayName,
} from './schedule';

/** The API's limit (docs/reports.md). */
export const MAX_RECIPIENTS = 20;

const FORMATS: TransferFormat[] = ['csv', 'xlsx', 'json'];

/** What a new report starts from: an export's name and the list's filters and sort. */
export interface ReportDraft {
  exporter?: string;
  filters?: Record<string, string>;
  sort?: string;
}

const email = z.email();

/**
 * Create or edit a scheduled report: what to export (an export the user may
 * run, `GET /v1/data`), in which format, when (daily, weekly, monthly at an
 * hour of its time zone) and to whom. Its filters come from the list it was
 * scheduled from; they are shown, not edited here.
 */
export function ReportDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Editing this report; else a new one from `draft`. */
  report?: Report;
  draft?: ReportDraft;
}) {
  const { t, i18n } = useTranslation('reports');
  const catalog = useQuery({ ...catalogQuery, meta: { errorToast: false } });
  const create = useCreateReport();
  const update = useUpdateReport({ form: true });
  const [error, setError] = useState<string>();
  const { report } = props;
  const filters = report?.filters ?? props.draft?.filters ?? {};
  const sort = report ? report.sort : props.draft?.sort;

  const exporters = useMemo(
    () =>
      (catalog.data?.exports ?? []).map((e) => ({
        value: e.name,
        label: e.name,
      })),
    [catalog.data],
  );
  const timeZones = useMemo(
    () =>
      Intl.supportedValuesOf('timeZone').map((zone) => ({
        value: zone,
        label: zone.replaceAll('_', ' '),
      })),
    [],
  );
  const schedule = report?.schedule;

  const form = useAppForm({
    defaultValues: {
      name: report?.name ?? '',
      exporter: report?.exporter ?? props.draft?.exporter ?? '',
      format: (report?.format ?? 'csv') as string,
      every: (schedule?.every ?? 'weekly') as string,
      weekday: String(schedule?.every === 'weekly' ? schedule.weekday : 1),
      day: String(schedule?.every === 'monthly' ? schedule.day : 1),
      hour: String(schedule?.hour ?? 8),
      timezone: report?.timezone ?? '',
      recipients: report?.recipients ?? ([] as string[]),
      active: report?.active ?? true,
    },
    validators: {
      onSubmit: z.object({
        name: z
          .string()
          .trim()
          .min(1, t('form.nameRequired'))
          .max(
            REPORT_LIMITS.name,
            t('form.nameTooLong', { max: REPORT_LIMITS.name }),
          ),
        exporter: z.string().min(1, t('form.exporterRequired')),
        format: z.string(),
        every: z.string(),
        weekday: z.string(),
        day: z.string(),
        hour: z.string(),
        timezone: z.string(),
        recipients: z
          .array(z.string())
          .max(
            MAX_RECIPIENTS,
            t('form.tooManyRecipients', { max: MAX_RECIPIENTS }),
          )
          .refine(
            (list) => list.every((item) => email.safeParse(item).success),
            {
              message: t('form.recipientInvalid'),
            },
          ),
        active: z.boolean(),
      }),
    },
    onSubmit: async ({ value }) => {
      setError(undefined);
      const hour = Number(value.hour);
      const when: Schedule =
        value.every === 'daily'
          ? { every: 'daily', hour }
          : value.every === 'monthly'
            ? { every: 'monthly', day: Number(value.day), hour }
            : { every: 'weekly', weekday: Number(value.weekday), hour };
      const body: ReportCreate = {
        name: value.name.trim(),
        exporter: value.exporter,
        format: value.format as TransferFormat,
        filters,
        ...(sort && { sort }),
        schedule: when,
        active: value.active,
        // Empty: a user's own address (the API's default on create).
        ...(value.recipients.length > 0 && { recipients: value.recipients }),
        ...(value.timezone && { timezone: value.timezone }),
      };
      try {
        if (report) {
          await update.mutateAsync({
            id: report.id,
            body: { ...body, recipients: value.recipients },
          });
        } else {
          await create.mutateAsync(body);
        }
        form.reset();
        props.onOpenChange(false);
      } catch (caught) {
        if (!applyFieldErrors(form, caught)) {
          setError(errorMessage(caught));
        }
      }
    },
  });

  // The list's order is part of what the report replays: shown beside its filters.
  const filterEntries = Object.entries({ ...filters, ...(sort && { sort }) });

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {report ? t('form.editTitle') : t('form.createTitle')}
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
            <form.AppField name="name">
              {(field) => (
                <field.TextField
                  label={t('form.name')}
                  placeholder={t('form.namePlaceholder')}
                  autoFocus
                />
              )}
            </form.AppField>
            <form.AppField name="exporter">
              {(field) => (
                <field.SelectField
                  label={t('form.exporter')}
                  options={exporters}
                  placeholder={t('form.exporterPlaceholder')}
                />
              )}
            </form.AppField>
            <Field>
              <FieldLabel>{t('form.filters')}</FieldLabel>
              {filterEntries.length === 0 ? (
                <FieldDescription>{t('form.noFilters')}</FieldDescription>
              ) : (
                <ul
                  className="flex flex-wrap gap-1"
                  aria-label={t('form.filters')}
                >
                  {filterEntries.map(([key, value]) => (
                    <li key={key}>
                      <Badge variant="outline" className="font-mono">
                        {key}: {value}
                      </Badge>
                    </li>
                  ))}
                </ul>
              )}
            </Field>
            <form.AppField name="format">
              {(field) => (
                <field.SelectField
                  label={t('form.format')}
                  options={FORMATS.map((f) => ({
                    value: f,
                    label: t(`formats.${f}`),
                  }))}
                />
              )}
            </form.AppField>
            <div className="grid gap-4 sm:grid-cols-3">
              <form.AppField name="every">
                {(field) => (
                  <field.SelectField
                    label={t('form.every')}
                    options={(['daily', 'weekly', 'monthly'] as const).map(
                      (every) => ({ value: every, label: t(`every.${every}`) }),
                    )}
                  />
                )}
              </form.AppField>
              <form.Subscribe selector={(state) => state.values.every}>
                {(every) =>
                  every === 'weekly' ? (
                    <form.AppField name="weekday">
                      {(field) => (
                        <field.SelectField
                          label={t('form.weekday')}
                          options={WEEKDAYS.map((d) => ({
                            value: String(d),
                            label: weekdayName(d, i18n.language),
                          }))}
                        />
                      )}
                    </form.AppField>
                  ) : every === 'monthly' ? (
                    <form.AppField name="day">
                      {(field) => (
                        <field.SelectField
                          label={t('form.day')}
                          options={MONTH_DAYS.map((d) => ({
                            value: String(d),
                            label: String(d),
                          }))}
                        />
                      )}
                    </form.AppField>
                  ) : (
                    <span className="hidden sm:block" />
                  )
                }
              </form.Subscribe>
              <form.AppField name="hour">
                {(field) => (
                  <field.SelectField
                    label={t('form.hour')}
                    options={HOURS.map((h) => ({
                      value: String(h),
                      label: hourLabel(h, i18n.language),
                    }))}
                  />
                )}
              </form.AppField>
            </div>
            <form.AppField name="timezone">
              {(field) => (
                <field.SelectField
                  label={t('form.timezone')}
                  options={timeZones}
                  placeholder={t('form.timezoneDefault')}
                />
              )}
            </form.AppField>
            <form.Field name="recipients">
              {(field) => {
                const invalid =
                  field.state.meta.isTouched && !field.state.meta.isValid;
                return (
                  <Field data-invalid={invalid}>
                    {/* Dice UI's tags-input: an address per tag, pasted lists split. */}
                    <TagsInput
                      className="w-full"
                      value={field.state.value}
                      onValueChange={(next) => field.handleChange(next)}
                      addOnPaste
                      blurBehavior="add"
                      delimiter=","
                      max={MAX_RECIPIENTS}
                    >
                      <TagsInputLabel>{t('form.recipients')}</TagsInputLabel>
                      <TagsInputList>
                        {field.state.value.map((address) => (
                          <TagsInputItem key={address} value={address}>
                            {address}
                          </TagsInputItem>
                        ))}
                        <TagsInputInput
                          type="email"
                          placeholder={t('form.recipientsPlaceholder')}
                        />
                      </TagsInputList>
                    </TagsInput>
                    <FieldDescription>
                      {t('form.recipientsHint', { max: MAX_RECIPIENTS })}
                    </FieldDescription>
                    {invalid && <FieldError errors={field.state.meta.errors} />}
                  </Field>
                );
              }}
            </form.Field>
            <form.Field name="active">
              {(field) => (
                <Field orientation="horizontal">
                  <Switch
                    id="report-active"
                    checked={field.state.value}
                    onCheckedChange={(checked) => field.handleChange(checked)}
                  />
                  <FieldLabel htmlFor="report-active">
                    {t('form.active')}
                  </FieldLabel>
                </Field>
              )}
            </form.Field>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => props.onOpenChange(false)}
              >
                {t('form.cancel')}
              </Button>
              <form.AppForm>
                <form.SubmitButton>
                  {report ? t('form.save') : t('form.create')}
                </form.SubmitButton>
              </form.AppForm>
            </DialogFooter>
          </FieldGroup>
        </form>
      </DialogContent>
    </Dialog>
  );
}
