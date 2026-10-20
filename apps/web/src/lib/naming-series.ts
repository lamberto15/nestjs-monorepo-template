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
export type NamingVariable =
  GetResponse<'/v1/naming-series/variables'>['items'][number];
export type NamingCondition = NamingSeries['conditions'][number];
export type NamingField = NumberedSubject['fields'][number];
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

/** The variables a pattern may print (`FY`, `ABBR`…), from the API. */
export const namingVariablesQuery = queryOptions({
  queryKey: ['naming-series', 'variables'],
  queryFn: async () =>
    (await unwrap(api.GET('/v1/naming-series/variables'))).items,
  staleTime: 5 * 60 * 1000,
});

/** The date parts of a pattern (docs/sequences.md), in the app time zone. */
export const DATE_PARTS = ['YYYY', 'YY', 'MM', 'DD', 'JJJ', 'WW'] as const;

/**
 * The record fields a pattern prints: its `{name}` parts that are fields of
 * the subject (variables and date parts in braces are not). In order, once.
 */
export function patternFields(
  pattern: string,
  fields: NamingField[],
): NamingField[] {
  const printed = new Set<string>();
  for (const match of pattern.matchAll(/\{([^{}]+)\}/g)) {
    printed.add(match[1]!);
  }
  return fields.filter((f) => f.kind !== 'boolean' && printed.has(f.name));
}

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
