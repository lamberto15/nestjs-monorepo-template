import { queryOptions } from '@tanstack/react-query';
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
 * The consents this app asks for. The API records any kind and version the
 * app names (`POST /v1/account/consents`), and keeps no list of its own: the
 * kinds, their current versions and which are required are the app's to
 * declare (docs/auth.md). Publish a new version of a text: change its
 * `version` here, and everyone sees they agreed to an older one.
 */
export const consentKinds: readonly {
  kind: string;
  version: string;
  required: boolean;
}[] = [
  { kind: 'terms', version: '2026-01', required: true },
  { kind: 'privacy', version: '2026-01', required: true },
  { kind: 'marketing', version: '2026-01', required: false },
];

/** This browser's list of the account exports it started (transfer/api.ts). */
export const ACCOUNT_EXPORTS_KEY = 'account-exports';

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
