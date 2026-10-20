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
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { errorMessage } from '@/lib/errors';
import type { NamingSeries } from '@/lib/naming-series';
import { counterQuery, useSetCounter } from './api';

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
  const counter = useQuery(counterQuery(series.id));
  const setCounter = useSetCounter();
  const [value, setValue] = useState<string>();
  const [error, setError] = useState<string>();

  const shown = value ?? (counter.data ? String(counter.data.current) : '');

  const submit = async () => {
    setError(undefined);
    const current = Number(shown);
    if (shown.trim() === '' || !Number.isSafeInteger(current) || current < 0) {
      setError(t('counter.invalid'));
      return;
    }
    try {
      await setCounter.mutateAsync({ id: series.id, current });
      toast.success(t('counter.saved', { pattern: series.pattern }));
      props.onOpenChange(false);
    } catch (caught) {
      setError(
        isApiError(caught) && caught.status === 409
          ? t('counter.tooLow', { current: counter.data?.current })
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
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-muted-foreground">{t('counter.key')}</dt>
              <dd className="font-mono">{counter.data.key}</dd>
              <dt className="text-muted-foreground">{t('counter.current')}</dt>
              <dd>{counter.data.current}</dd>
              <dt className="text-muted-foreground">{t('counter.next')}</dt>
              <dd className="font-mono">{counter.data.next}</dd>
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
