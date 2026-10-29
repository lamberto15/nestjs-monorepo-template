import { unwrap, type GetResponse } from '@nestjs-monorepo-template/api-client';
import {
  queryOptions,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import { api } from '@/lib/api';

/** The open findings per subject and the last scan (docs/data-quality.md). */
export type DataQualitySummary = GetResponse<'/v1/data-quality'>;
export type DataQualityScan = NonNullable<DataQualitySummary['lastScan']>;
export type DataQualityFinding =
  GetResponse<'/v1/data-quality/subjects/{subject}/findings'>['items'][number];

const running = (scan: DataQualityScan | null | undefined) =>
  scan?.status === 'queued' || scan?.status === 'running';

export const dataQualityQuery = queryOptions({
  queryKey: ['data-quality', 'summary'],
  queryFn: () => unwrap(api.GET('/v1/data-quality')),
  // Follows a running scan's progress, then stops.
  refetchInterval: (query) =>
    running(query.state.data?.lastScan) ? 2000 : false,
});

export const findingsQuery = (subject: string, dismissed: boolean) =>
  queryOptions({
    queryKey: ['data-quality', 'findings', subject, dismissed],
    queryFn: () =>
      unwrap(
        api.GET('/v1/data-quality/subjects/{subject}/findings', {
          params: {
            path: { subject },
            query: { dismissed: dismissed ? 'true' : 'false', limit: 100 },
          },
        }),
      ),
  });

/** Every data-quality query again: a scan, a dismissal or a recheck changes the counts and the lists. */
function useRefresh() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: ['data-quality'] });
}

export function useStartScan() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: () => unwrap(api.POST('/v1/data-quality/scans')),
    onSuccess: refresh,
  });
}

export function useDismissFinding() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (id: string) =>
      unwrap(
        api.POST('/v1/data-quality/findings/{id}/dismiss', {
          params: { path: { id } },
        }),
      ),
    onSuccess: refresh,
  });
}

export function useRecheckFinding() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (id: string) =>
      unwrap(
        api.POST('/v1/data-quality/findings/{id}/recheck', {
          params: { path: { id } },
        }),
      ),
    onSuccess: refresh,
  });
}
