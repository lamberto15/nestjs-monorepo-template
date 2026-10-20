import { useState } from 'react';
import { useFlag } from '@/features/settings/use-flag';

/** The flag in `notes.richText` (note-settings.ts, docs/settings.md). */
export const RICH_TEXT_KEY = 'notes.richText';

/**
 * Whether bodies are Markdown for this user: the `notes.richText` flag, as
 * `GET /v1/settings` resolves it (their value, their team's, the tenant's, the
 * rollout, the platform value, the default; see `useFlag`). Off while it loads
 * and when it can't be read: a failing settings call leaves the plain text it
 * always was; `pending` says it is still loading.
 */
export function useRichText() {
  const { enabled, pending } = useFlag(RICH_TEXT_KEY);
  return { richText: enabled, pending };
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
