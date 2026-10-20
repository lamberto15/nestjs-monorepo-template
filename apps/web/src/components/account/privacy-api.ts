import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';
import { unwrap, type GetResponse } from '@nestjs-monorepo-template/api-client';
import { api } from '@/lib/api';
import type { TransferFormat } from '@/features/transfer/api';

/** `GET /v1/account`: a pending deletion and the latest consent of each kind. */
export type AccountState = GetResponse<'/v1/account'>;
export type Consent = AccountState['consents'][number];

export const accountQuery = queryOptions({
  queryKey: ['account'],
  queryFn: () => unwrap(api.GET('/v1/account')),
});

/**
 * `GET /v1/account/consent-kinds` (public): the kinds of consent the API asks
 * for, each with its current `version`, whether it is `required` (it cannot
 * be withdrawn) and a `label` and `description` in the request's language
 * (docs/auth.md). The app keeps no list of its own: publishing a new version
 * of a text is the API's change, and everyone sees they agreed to an older
 * one. The language is in the key because the texts follow it.
 */
export type ConsentKind =
  GetResponse<'/v1/account/consent-kinds'>['items'][number];

export const consentKindsQuery = (language: string) =>
  queryOptions({
    queryKey: ['consent-kinds', language],
    queryFn: async () =>
      (await unwrap(api.GET('/v1/account/consent-kinds'))).items,
  });

/** The caller's account exports: one entry of `GET /v1/account/exports`. */
export type AccountExport = GetResponse<'/v1/account/exports'>['items'][number];

export const ACCOUNT_EXPORTS_KEY = ['account', 'exports'] as const;

const EXPORTS_PAGE = 5;

/** A download link is valid 30 minutes from the answer: renewed before that. */
const LINK_REFRESH_MS = 25 * 60 * 1000;

/**
 * When the list is asked again: every second while an export is with the
 * worker, else about every 25 minutes while a finished one shows its link
 * (so the link stays valid), else not at all.
 */
export function exportsRefreshInterval(
  items: Pick<AccountExport, 'status' | 'result'>[],
): number | false {
  if (items.some((i) => i.status === 'queued' || i.status === 'running')) {
    return 1000;
  }
  return items.some((i) => i.status === 'completed' && i.result?.url)
    ? LINK_REFRESH_MS
    : false;
}

/**
 * `GET /v1/account/exports`: the caller's account exports, newest first, by
 * cursor, each as a transfer (a finished one with its download link, valid 30
 * minutes from the answer). Polled while one is still with the worker, and renewed while a link shows; a
 * finished one is kept 7 days (`expiresAt`), then no longer listed.
 */
export const accountExportsQuery = infiniteQueryOptions({
  queryKey: ACCOUNT_EXPORTS_KEY,
  initialPageParam: undefined as string | undefined,
  queryFn: ({ pageParam }) =>
    unwrap(
      api.GET('/v1/account/exports', {
        params: {
          query: {
            limit: EXPORTS_PAGE,
            ...(pageParam && { cursor: pageParam }),
          },
        },
      }),
    ),
  getNextPageParam: (last) => last.nextCursor ?? undefined,
  refetchInterval: (query) =>
    exportsRefreshInterval(
      query.state.data?.pages.flatMap((page) => page.items) ?? [],
    ),
});

/**
 * `POST /v1/account/export`: 202 with `{ id, status }`. The OpenAPI document
 * describes no body for the 202, so the type is written here.
 */
export async function startAccountExport(format: TransferFormat) {
  const started = (await unwrap(
    api.POST('/v1/account/export', { body: { format } }),
  )) as unknown as { id: string; status: string };
  return started;
}
