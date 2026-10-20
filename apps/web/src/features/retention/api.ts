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

/** A declared rule and the tenant's choice for it (docs/retention.md). */
export type RetentionRule = GetResponse<'/v1/retention/rules'>['items'][number];
export type RetentionChange = NonNullable<
  paths['/v1/retention/rules/{name}']['put']['requestBody']
>['content']['application/json'];

// The rules are declared in code: a handful, one page.
export const retentionRulesQuery = queryOptions({
  queryKey: ['retention', 'rules'],
  queryFn: () => unwrap(api.GET('/v1/retention/rules')),
});

export function useSetRetention() {
  const queryClient = useQueryClient();
  return useMutation({
    // The card shows the refusal (days below the minimum is a 400).
    meta: { errorToast: false },
    mutationFn: (input: { name: string; change: RetentionChange }) =>
      unwrap(
        api.PUT('/v1/retention/rules/{name}', {
          params: { path: { name: input.name } },
          body: input.change,
        }),
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['retention'] }),
  });
}
