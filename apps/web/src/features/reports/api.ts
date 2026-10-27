import {
  unwrap,
  type GetResponse,
  type paths,
} from '@nestjs-monorepo-template/api-client';
import {
  queryOptions,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import { api } from '@/lib/api';

/** A scheduled report (docs/reports.md): an export run for its owner on a schedule. */
export type Report = GetResponse<'/v1/reports/{id}'>;
export type Schedule = Report['schedule'];
export type ReportCreate = NonNullable<
  paths['/v1/reports']['post']['requestBody']
>['content']['application/json'];
export type ReportChanges = NonNullable<
  paths['/v1/reports/{id}']['patch']['requestBody']
>['content']['application/json'];

/**
 * A report's name mirrors the API's `maxLength`; lib/limits.test.ts compares
 * it with openapi.json.
 */
export const REPORT_LIMITS = { name: 200 } as const;

/** Every reports query starts with this key (one invalidation covers all). */
export const reportsKey = ['reports'] as const;

/** At most 20 active reports per owner: one page holds them all. */
const PAGE = 100;

/** The caller's reports, the next to run first. */
export const reportsQuery = queryOptions({
  queryKey: [...reportsKey, 'list'],
  queryFn: () =>
    unwrap(
      api.GET('/v1/reports', {
        params: { query: { sort: 'nextRunAt', limit: PAGE } },
      }),
    ),
});

function useRefresh() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: reportsKey });
}

/** Form errors are the dialog's: no global toast for create and update. */
export function useCreateReport() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (body: ReportCreate) =>
      unwrap(api.POST('/v1/reports', { body })),
    onSuccess: refresh,
    meta: { errorToast: false },
  });
}

/** `form`: the edit dialog shows the errors (no toast); a switch gets a toast. */
export function useUpdateReport(options: { form?: boolean } = {}) {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (input: { id: string; body: ReportChanges }) =>
      unwrap(
        api.PATCH('/v1/reports/{id}', {
          params: { path: { id: input.id } },
          body: input.body,
        }),
      ),
    onSuccess: refresh,
    meta: { errorToast: !options.form },
  });
}

export function useDeleteReport() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (id: string) =>
      unwrap(api.DELETE('/v1/reports/{id}', { params: { path: { id } } })),
    onSuccess: refresh,
  });
}

/** Runs it now: 202 with the transfer (`GET /v1/data/transfers/{id}`). */
export function useRunReport() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (id: string) =>
      unwrap(api.POST('/v1/reports/{id}/run', { params: { path: { id } } })),
    onSuccess: refresh,
  });
}
