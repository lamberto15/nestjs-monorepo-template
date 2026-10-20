import { useQuery } from '@tanstack/react-query';
import { settingsQuery } from './settings';

/**
 * Whether the flag `key` is on for this user: the value `GET /v1/settings`
 * resolves (enforced platform value, their value, their team's, the tenant's,
 * the rollout, the platform value, the default; docs/settings.md). Off while
 * it loads and when it can't be read (no retries, no error toast: a failing
 * settings call leaves the feature off); `pending` says it is still loading.
 * A setting changes rarely, so it is kept five minutes before it is read again.
 */
export function useFlag(key: string) {
  const { data, isPending } = useQuery({
    ...settingsQuery,
    staleTime: 5 * 60_000,
    retry: false,
    meta: { errorToast: false },
  });
  const flag = data?.find((setting) => setting.key === key);
  return { enabled: flag?.value === true, pending: isPending };
}
