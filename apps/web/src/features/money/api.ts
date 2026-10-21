import { unwrap } from '@nestjs-monorepo-template/api-client';
import { queryOptions } from '@tanstack/react-query';
import { api } from '@/lib/api';

export const moneyKey = ['money'] as const;

/**
 * The rates of the newest working day on or before `date` (default today,
 * UTC). 404 `rates_unavailable` when none was fetched: the page explains it.
 */
export const ratesQuery = (date?: string) =>
  queryOptions({
    queryKey: [...moneyKey, 'rates', date ?? null],
    queryFn: () =>
      unwrap(
        api.GET('/v1/money/rates', {
          params: { query: date ? { date } : {} },
        }),
      ),
    retry: false,
  });

/** `GET /v1/money/convert`, for a filled form only (see `enabled`). */
export const convertQuery = (input: {
  amount: string;
  from: string;
  to: string;
}) =>
  queryOptions({
    queryKey: [...moneyKey, 'convert', input],
    queryFn: () =>
      unwrap(
        api.GET('/v1/money/convert', {
          params: {
            query: { amount: input.amount, currency: input.from, to: input.to },
          },
        }),
      ),
    retry: false,
    meta: { errorToast: false },
  });
