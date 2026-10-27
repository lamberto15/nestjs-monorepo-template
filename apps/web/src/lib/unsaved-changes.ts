import { useStore, type AnyFormApi } from '@tanstack/react-form';
import { useBlocker } from '@tanstack/react-router';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Asks before the user leaves a form with unsaved input, with TanStack
 * Router's navigation blocking (its documented `useBlocker`): a link, back
 * and forward ask in the app's words; a reload or a closed tab ask in the
 * browser's own (`beforeunload` shows no text of the page's).
 *
 * Unsaved: the form's values differ from its defaults (`isDefaultValue`;
 * `isDirty` stays true once anything was typed, even when undone), or `also`
 * (input kept outside the form, such as a note's custom fields).
 *
 * Never asked: where the app goes itself after a save (`ignoreBlocker` on
 * that navigation), and the session-end redirects (app.tsx, sign-out): a
 * session that ended has nothing left to save under it.
 */
export function useUnsavedChangesGuard(form: AnyFormApi, also = false) {
  const { t } = useTranslation();
  const changed = useStore(form.store, (state) => !state.isDefaultValue);
  const dirty = changed || also;
  const shouldBlockFn = useCallback(
    () => !window.confirm(t('app.unsavedChanges')),
    [t],
  );
  useBlocker({ shouldBlockFn, enableBeforeUnload: dirty, disabled: !dirty });
}
