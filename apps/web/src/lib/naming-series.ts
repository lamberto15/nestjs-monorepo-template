import {
  unwrap,
  type GetResponse,
  type paths,
} from '@nestjs-monorepo-template/api-client';
import { queryOptions, useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

/**
 * Naming series (docs/sequences.md): the number formats administrators define
 * per subject (`INV-.YYYY.-.#####`). Read here by the admin page and by the
 * record forms that let the user pick the series of a new record.
 */
export type NamingSeries = GetResponse<'/v1/naming-series'>['items'][number];
export type NumberedSubject =
  GetResponse<'/v1/naming-series/subjects'>['items'][number];
export type NamingCounter = GetResponse<'/v1/naming-series/{id}/counter'>;
export type NamingSeriesCreate = NonNullable<
  paths['/v1/naming-series']['post']['requestBody']
>['content']['application/json'];
export type NamingSeriesChanges = NonNullable<
  paths['/v1/naming-series/{id}']['patch']['requestBody']
>['content']['application/json'];

const PAGE_SIZE = 100;
/** Series read at most: 10 pages of 100, far past what anyone defines. */
const MAX_PAGES = 10;

async function fetchSeries(subject?: string): Promise<NamingSeries[]> {
  const series: NamingSeries[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await unwrap(
      api.GET('/v1/naming-series', {
        params: {
          query: { subject, sort: 'pattern', limit: PAGE_SIZE, cursor },
        },
      }),
    );
    series.push(...result.items);
    if (!result.nextCursor) break;
    cursor = result.nextCursor;
  }
  return series;
}

/** Every subject's series (the admin page). Under `['naming-series', …]`. */
export const allNamingSeriesQuery = queryOptions({
  queryKey: ['naming-series', 'all'],
  queryFn: () => fetchSeries(),
});

/** The subjects whose records take a number, with the format in code. */
export const numberedSubjectsQuery = queryOptions({
  queryKey: ['naming-series', 'subjects'],
  queryFn: async () =>
    (await unwrap(api.GET('/v1/naming-series/subjects'))).items,
});

/**
 * One subject's series, for a create form's picker. Reading them needs no
 * permission the form could lack: a refusal leaves the list empty (the picker
 * stays hidden and the record takes the default series).
 */
export function useSubjectNamingSeries(subject: string) {
  return useQuery({
    queryKey: ['naming-series', subject],
    queryFn: () => fetchSeries(subject),
    meta: { errorToast: false },
    retry: false,
    staleTime: 60 * 1000,
  });
}
