import { useQuery } from '@tanstack/react-query';
import { settingsQuery } from '@/features/settings/settings';

/** The flag in `notes.richText` (note-settings.ts, docs/settings.md). */
export const RICH_TEXT_KEY = 'notes.richText';

/**
 * Whether bodies are Markdown for this user: the `notes.richText` flag, as
 * `GET /v1/settings` resolves it (their value, their team's, the tenant's, the
 * rollout, the default). Off while it loads and when it can't be read, so a
 * failing settings call leaves the plain text it always was; `pending` says
 * it is still loading.
 */
export function useRichText() {
  const { data, isPending } = useQuery({
    ...settingsQuery,
    meta: { errorToast: false },
  });
  const flag = data?.find((setting) => setting.key === RICH_TEXT_KEY);
  return { richText: flag?.value === true, pending: isPending };
}
