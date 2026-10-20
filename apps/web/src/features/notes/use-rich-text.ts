import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { settingsQuery } from '@/features/settings/settings';

/** The flag in `notes.richText` (note-settings.ts, docs/settings.md). */
export const RICH_TEXT_KEY = 'notes.richText';

/**
 * Whether bodies are Markdown for this user: the `notes.richText` flag, as
 * `GET /v1/settings` resolves it (their value, their team's, the tenant's, the
 * rollout, the default). Off while it loads and when it can't be read (no
 * retries: a failing settings call leaves the plain text it always was);
 * `pending` says it is still loading. A setting changes rarely, so it is kept
 * five minutes before it is read again.
 */
export function useRichText() {
  const { data, isPending } = useQuery({
    ...settingsQuery,
    staleTime: 5 * 60_000,
    retry: false,
    meta: { errorToast: false },
  });
  const flag = data?.find((setting) => setting.key === RICH_TEXT_KEY);
  return { richText: flag?.value === true, pending: isPending };
}

/**
 * `useRichText()` for a form: the answer it first gets stays, so a refetch
 * (the window regained focus, an administrator changed the flag) never swaps
 * the control under the user's hands and loses what they typed. The next
 * time the form opens it asks again.
 */
export function useRichTextOnOpen() {
  const current = useRichText();
  const [settled, setSettled] = useState<boolean>();
  if (!current.pending && settled === undefined) {
    setSettled(current.richText);
  }
  return {
    richText: settled ?? current.richText,
    pending: settled === undefined,
  };
}
