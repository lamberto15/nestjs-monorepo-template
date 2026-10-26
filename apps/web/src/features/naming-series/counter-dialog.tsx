import { isApiError } from '@nestjs-monorepo-template/api-client';
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
  FieldLabel,
} from '@nestjs-monorepo-template/ui/components/field';
import { Input } from '@nestjs-monorepo-template/ui/components/input';
import { Skeleton } from '@nestjs-monorepo-template/ui/components/skeleton';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { errorMessage } from '@/lib/errors';
import { useStaleDraftSession } from '@/lib/form';
import {
  numberedSubjectsQuery,
  patternFields,
  type NamingField,
  type NamingSeries,
} from '@/lib/naming-series';
import { counterQuery, previewQuery, useSetCounter } from './api';

/** The API's values for what the inputs hold: numbers as numbers. */
function typedValues(fields: NamingField[], raw: Record<string, string>) {
  const values: Record<string, string | number> = {};
  for (const f of fields) {
    const text = (raw[f.name] ?? '').trim();
    if (text === '') return undefined;
    const n = Number(text);
    values[f.name] = f.kind === 'number' && Number.isFinite(n) ? n : text;
  }
  return values;
}

/**
 * A series' counter for the current period (docs/sequences.md): the last
 * value taken and the number the next record gets. Setting it continues the
 * numbers of another system; never below the last value taken (409).
 */
export function CounterDialog(props: {
  series: NamingSeries;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation('naming-series');
  const { series } = props;
  const staleDraftSession = useStaleDraftSession();
  const counter = useQuery(counterQuery(series.id));
  const subjects = useQuery({
    ...numberedSubjectsQuery,
    meta: { errorToast: false },
  });
  // A pattern that prints fields counts per value: one input for each.
  const fields = patternFields(
    series.pattern,
    subjects.data?.find((s) => s.subject === series.subject)?.fields ?? [],
  );
  const [raw, setRaw] = useState<Record<string, string>>({});
  const values = typedValues(fields, raw);
  const [settled, setSettled] = useState(values);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(values), 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(values)]);
  const valueCounter = useQuery({
    ...previewQuery(series.subject, series.pattern, {
      dateField: series.dateField ?? undefined,
      values: settled,
    }),
    enabled: fields.length > 0 && !!settled,
  });
  // The counter shown: the one of the values typed, else the period's.
  const shownCounter =
    fields.length > 0
      ? settled
        ? valueCounter.data
        : undefined
      : counter.data;
  const setCounter = useSetCounter();
  const [value, setValue] = useState<string>();
  const [error, setError] = useState<string>();

  const shown = value ?? (shownCounter ? String(shownCounter.current) : '');

  const submit = async () => {
    if (staleDraftSession()) return;
    setError(undefined);
    const current = Number(shown);
    if (shown.trim() === '' || !Number.isSafeInteger(current) || current < 0) {
      setError(t('counter.invalid'));
      return;
    }
    if (fields.length > 0 && !values) {
      setError(t('counter.valuesRequired'));
      return;
    }
    try {
      await setCounter.mutateAsync({
        id: series.id,
        current,
        ...(fields.length > 0 && values && { values }),
      });
      toast.success(t('counter.saved', { pattern: series.pattern }));
      props.onOpenChange(false);
    } catch (caught) {
      setError(
        isApiError(caught) && caught.status === 409
          ? t('counter.tooLow', { current: shownCounter?.current })
          : errorMessage(caught),
      );
    }
  };

  return (
    <Dialog open onOpenChange={props.onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('counter.title')}</DialogTitle>
          <DialogDescription>
            {t('counter.description', { pattern: series.pattern })}
          </DialogDescription>
        </DialogHeader>
        {counter.isPending && <Skeleton className="h-20 w-full" aria-busy />}
        {counter.isError && (
          <p role="alert" className="text-sm text-destructive">
            {errorMessage(counter.error)}
          </p>
        )}
        {counter.isSuccess && (
          <form
            noValidate
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            {fields.length > 0 && (
              <div className="flex flex-col gap-2">
                <p className="text-sm text-muted-foreground">
                  {t('counter.valuesHint', {
                    fields: fields.map((f) => `{${f.name}}`).join(', '),
                  })}
                </p>
                {fields.map((f) => (
                  <Field key={f.name}>
                    <FieldLabel htmlFor={`series-value-${f.name}`}>
                      {t('counter.valueOf', { field: f.name })}
                    </FieldLabel>
                    <Input
                      id={`series-value-${f.name}`}
                      type={
                        f.kind === 'number'
                          ? 'number'
                          : f.kind === 'date'
                            ? 'date'
                            : 'text'
                      }
                      value={raw[f.name] ?? ''}
                      onChange={(event) => {
                        setValue(undefined);
                        setRaw({ ...raw, [f.name]: event.target.value });
                      }}
                    />
                  </Field>
                ))}
              </div>
            )}
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-muted-foreground">{t('counter.key')}</dt>
              <dd className="font-mono">
                {(shownCounter ?? counter.data).key}
              </dd>
              <dt className="text-muted-foreground">{t('counter.current')}</dt>
              <dd>{shownCounter ? shownCounter.current : '–'}</dd>
              <dt className="text-muted-foreground">{t('counter.next')}</dt>
              <dd className="font-mono">
                {shownCounter ? shownCounter.next : counter.data.next}
              </dd>
            </dl>
            <Field data-invalid={!!error}>
              <FieldLabel htmlFor="series-counter">
                {t('counter.set')}
              </FieldLabel>
              <Input
                id="series-counter"
                type="number"
                min={0}
                step={1}
                inputMode="numeric"
                value={shown}
                aria-invalid={!!error}
                onChange={(event) => setValue(event.target.value)}
              />
              <FieldDescription>{t('counter.hint')}</FieldDescription>
              {error && <FieldError>{error}</FieldError>}
            </Field>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => props.onOpenChange(false)}
              >
                {t('form.cancel')}
              </Button>
              <Button type="submit" disabled={setCounter.isPending}>
                {t('counter.save')}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
