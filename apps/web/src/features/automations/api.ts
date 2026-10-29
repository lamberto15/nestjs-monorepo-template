import {
  unwrap,
  type GetResponse,
  type paths,
} from '@nestjs-monorepo-template/api-client';
import {
  infiniteQueryOptions,
  queryOptions,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import { api } from '@/lib/api';

export type AutomationRule =
  GetResponse<'/v1/automation-rules'>['items'][number];
export type AutomationAction = AutomationRule['actions'][number];

type JsonBody<
  P extends keyof paths,
  M extends 'post' | 'patch',
> = paths[P][M] extends {
  requestBody: { content: { 'application/json': infer B } };
}
  ? B
  : never;

/** What creating a rule sends: its name, trigger, conditions and actions. */
export type RuleBody = JsonBody<'/v1/automation-rules', 'post'>;
export type SimulateBody = JsonBody<'/v1/automation-rules/simulate', 'post'>;
export type Simulation = Awaited<ReturnType<typeof simulate>>;

export const PAGE_SIZE = 25;

/** Everything of the rules starts with this key. */
export const rulesKey = ['automation-rules'] as const;

/** The rules, newest first, in cursor pages (`GET /v1/automation-rules`). */
export const rulesQuery = () =>
  infiniteQueryOptions({
    queryKey: [...rulesKey, 'list'],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET('/v1/automation-rules', {
          params: {
            query: {
              limit: PAGE_SIZE,
              ...(pageParam && { cursor: pageParam }),
            },
          },
        }),
      ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

/** What rules may be about (`GET /v1/automation-rules/subjects`). */
export const subjectsQuery = queryOptions({
  queryKey: [...rulesKey, 'subjects'],
  queryFn: async () =>
    (await unwrap(api.GET('/v1/automation-rules/subjects'))).items,
  staleTime: 10 * 60 * 1000,
});

/** A rule's latest runs (`GET /v1/automation-rules/{id}/runs`). */
export const runsQuery = (id: string) =>
  queryOptions({
    queryKey: [...rulesKey, 'runs', id],
    queryFn: () =>
      unwrap(
        api.GET('/v1/automation-rules/{id}/runs', {
          params: { path: { id }, query: { limit: PAGE_SIZE } },
        }),
      ),
  });

const simulate = (body: SimulateBody) =>
  unwrap(api.POST('/v1/automation-rules/simulate', { body }));

// The dialogs show the refusals themselves (a 400 on a field): the global
// handler stays quiet.
export function useSimulate() {
  return useMutation({ meta: { errorToast: false }, mutationFn: simulate });
}

export function useSaveRule() {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { errorToast: false },
    mutationFn: ({ id, body }: { id?: string; body: RuleBody }) => {
      if (!id) {
        return unwrap(api.POST('/v1/automation-rules', { body }));
      }
      // The subject is chosen once: a rule about other records is another rule.
      const { subject: _subject, ...changes } = body;
      return unwrap(
        api.PATCH('/v1/automation-rules/{id}', {
          params: { path: { id } },
          body: changes,
        }),
      );
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: rulesKey }),
  });
}

/** Activate, disable or delete a rule. */
export function useRuleAction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      action,
    }: {
      id: string;
      action: 'activate' | 'disable' | 'delete';
    }) => {
      const params = { params: { path: { id } } };
      if (action === 'delete') {
        return unwrap(api.DELETE('/v1/automation-rules/{id}', params));
      }
      return unwrap(
        action === 'activate'
          ? api.POST('/v1/automation-rules/{id}/activate', params)
          : api.POST('/v1/automation-rules/{id}/disable', params),
      );
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: rulesKey }),
  });
}
