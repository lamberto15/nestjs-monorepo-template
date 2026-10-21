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
import { useQuery } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useFeature } from '@/lib/features';
import { errorMessage } from '@/lib/errors';
import { convertQuery, ratesQuery } from './api';
import { currencyName, formatAmount, formatRate } from './format';

/** Major units with an optional fraction: what the API takes before it checks the currency's decimals. */
const AMOUNT = /^-?\d+(\.\d+)?$/;

/**
 * Converts an amount between two currencies at the server's rates
 * (`GET /v1/money/convert`) and shows the rate and its day beside the result,
 * so a record form with money fields can drop it in. The currencies are the
 * ECB's (the euro and the day's rates). Shown only with `exchangeRates` on.
 * The conversion is the server's: the page never computes with floats.
 */
/** ISO 4217 codes in code-point order (the same in every locale). */
const byCode = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function CurrencyConverter(props: {
  /** Start values. */
  defaultAmount?: string;
  defaultFrom?: string;
  defaultTo?: string;
}) {
  const enabled = useFeature('exchangeRates');
  const { t, i18n } = useTranslation('money');
  const id = useId();
  const [amount, setAmount] = useState(props.defaultAmount ?? '1');
  const [from, setFrom] = useState(props.defaultFrom ?? 'EUR');
  const [to, setTo] = useState(props.defaultTo ?? 'USD');
  const rates = useQuery({ ...ratesQuery(), enabled });
  const valid = AMOUNT.test(amount.trim());
  const conversion = useQuery({
    ...convertQuery({ amount: amount.trim(), from, to }),
    enabled: enabled && valid && Boolean(from) && Boolean(to),
  });
  if (!enabled) {
    return null;
  }
  const currencies = rates.data
    ? [rates.data.base, ...Object.keys(rates.data.rates)].toSorted(byCode)
    : [from, to];
  const language = i18n.language;
  const picker = (
    label: string,
    value: string,
    onChange: (value: string) => void,
    field: string,
  ) => (
    <Field className="w-36">
      <FieldLabel htmlFor={`${id}-${field}`}>{label}</FieldLabel>
      <Select value={value} onValueChange={(next) => next && onChange(next)}>
        <SelectTrigger id={`${id}-${field}`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {[...new Set([value, ...currencies])].toSorted(byCode).map((code) => (
            <SelectItem key={code} value={code}>
              {code}
              <span className="text-muted-foreground">
                {' '}
                {currencyName(code, language)}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
  return (
    <section aria-label={t('converter.title')} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start gap-3">
        <Field className="w-40">
          <FieldLabel htmlFor={`${id}-amount`}>
            {t('converter.amount')}
          </FieldLabel>
          <Input
            id={`${id}-amount`}
            inputMode="decimal"
            value={amount}
            aria-invalid={!valid}
            onChange={(event) => setAmount(event.target.value)}
          />
          {!valid && (
            <FieldDescription className="text-destructive">
              {t('converter.badAmount')}
            </FieldDescription>
          )}
        </Field>
        {picker(t('converter.from'), from, setFrom, 'from')}
        {picker(t('converter.to'), to, setTo, 'to')}
      </div>
      <div aria-live="polite" className="text-sm">
        {conversion.isError && (
          <p role="alert" className="text-destructive">
            {errorMessage(conversion.error)}
          </p>
        )}
        {conversion.isSuccess && valid && (
          <>
            <p className="text-lg font-medium">
              {formatAmount(
                conversion.data.from.amount,
                conversion.data.from.currency,
                language,
              )}
              {' = '}
              {formatAmount(
                conversion.data.amount.amount,
                conversion.data.amount.currency,
                language,
              )}
            </p>
            <p className="text-muted-foreground">
              {t('converter.rate', {
                from: conversion.data.from.currency,
                rate: formatRate(conversion.data.rate, language),
                to: conversion.data.amount.currency,
                date: conversion.data.rateDate,
              })}
            </p>
          </>
        )}
      </div>
    </section>
  );
}
