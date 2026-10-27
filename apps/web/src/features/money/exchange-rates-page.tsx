import { Input } from '@nestjs-monorepo-template/ui/components/input';
import {
  Field,
  FieldLabel,
} from '@nestjs-monorepo-template/ui/components/field';
import { Skeleton } from '@nestjs-monorepo-template/ui/components/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@nestjs-monorepo-template/ui/components/table';
import { useQuery } from '@tanstack/react-query';
import { parseAsIsoDate, parseAsString, useQueryStates } from 'nuqs';
import { useTranslation } from 'react-i18next';
import { errorMessage } from '@/lib/errors';
import { Page, PageHeader } from '@/components/page-header';
import { ratesQuery } from './api';
import { CurrencyConverter } from './currency-converter';
import { currencyName, formatRate } from './format';

const urlState = { date: parseAsIsoDate, q: parseAsString };

/**
 * The ECB's euro reference rates of a day (`GET /v1/money/rates`): the date
 * is the picker's (default today; the API answers the newest working day on
 * or before it, and the page shows that day), searchable by code or name.
 * A native date input: the API takes a plain `yyyy-mm-dd`, which is what it
 * gives.
 */
export function ExchangeRatesPage() {
  const { t, i18n } = useTranslation('money');
  const [{ date, q }, setState] = useQueryStates(urlState);
  const picked = date ? date.toISOString().slice(0, 10) : undefined;
  const rates = useQuery({
    ...ratesQuery(picked),
    meta: { errorToast: false },
  });
  const needle = (q ?? '').trim().toLowerCase();
  const rows = Object.entries(rates.data?.rates ?? {})
    .map(([code, rate]) => ({
      code,
      rate,
      name: currencyName(code, i18n.language),
    }))
    .filter(
      (row) =>
        !needle ||
        row.code.toLowerCase().includes(needle) ||
        row.name.toLowerCase().includes(needle),
    )
    .toSorted((a, b) => a.code.localeCompare(b.code));
  return (
    <Page width="narrow">
      <PageHeader title={t('title')} description={t('description')} />
      <div className="flex flex-wrap items-end gap-3">
        <Field className="w-44">
          <FieldLabel htmlFor="rates-date">{t('date')}</FieldLabel>
          <Input
            id="rates-date"
            type="date"
            value={picked ?? ''}
            placeholder={t('today')}
            onChange={(event) => {
              const value = event.target.value;
              void setState({
                date: value ? new Date(`${value}T00:00:00Z`) : null,
              });
            }}
          />
        </Field>
        <Field className="w-56">
          <FieldLabel htmlFor="rates-search">{t('search')}</FieldLabel>
          <Input
            id="rates-search"
            type="search"
            value={q ?? ''}
            onChange={(event) =>
              void setState({ q: event.target.value || null })
            }
          />
        </Field>
      </div>
      {rates.isPending && <Skeleton className="h-40 w-full" aria-busy />}
      {rates.isError && (
        <p role="alert" className="text-sm text-muted-foreground">
          {t('empty')} {errorMessage(rates.error)}
        </p>
      )}
      {rates.data && (
        <>
          <p className="text-sm text-muted-foreground">
            {t('fetched', {
              day: rates.data.day,
              base: rates.data.base,
              source: rates.data.source.toUpperCase(),
            })}
          </p>
          {rows.length === 0 ? (
            <p className="text-sm">{t('none')}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('currency')}</TableHead>
                  <TableHead>{t('name')}</TableHead>
                  <TableHead className="text-end">
                    {t('perBase', { base: rates.data.base })}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.code}>
                    <TableCell className="font-medium">{row.code}</TableCell>
                    <TableCell>{row.name}</TableCell>
                    <TableCell className="text-end tabular-nums">
                      {formatRate(row.rate, i18n.language)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </>
      )}
      <section className="flex flex-col gap-2">
        <h2 className="text-base font-medium">{t('converter.title')}</h2>
        <CurrencyConverter />
      </section>
    </Page>
  );
}
