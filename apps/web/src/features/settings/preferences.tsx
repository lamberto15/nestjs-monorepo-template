import { unwrap } from '@nestjs-monorepo-template/api-client';
import { Button } from '@nestjs-monorepo-template/ui/components/button';
import { Skeleton } from '@nestjs-monorepo-template/ui/components/skeleton';
import { Spinner } from '@nestjs-monorepo-template/ui/components/spinner';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Section } from '@/components/account/section';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { FormAlert } from '@/lib/form';
import { useStaleDraftSession } from '@/lib/form';
import { SourceBadge } from './source-badge';
import { fromDraft, settingsQuery, toDraft, type Setting } from './settings';
import {
  ValueInput,
  boundsHint,
  formatValue,
  invalidText,
} from './value-input';

/** The settings this user may set for themselves (`canSetMine`). */
export function Preferences() {
  const { t } = useTranslation('settings');
  const { data, isPending } = useQuery(settingsQuery);
  if (isPending) {
    return <Skeleton className="h-40 w-full" />;
  }
  const mine = (data ?? []).filter((setting) => setting.canSetMine);
  if (mine.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">{t('preferences.empty')}</p>
    );
  }
  return (
    <>
      {mine.map((setting) => (
        <PreferenceRow key={setting.key} setting={setting} />
      ))}
    </>
  );
}

function PreferenceRow({ setting }: { setting: Setting }) {
  const { t } = useTranslation('settings');
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(toDraft(setting, setting.value));
  const [error, setError] = useState<string>();
  const staleDraftSession = useStaleDraftSession();
  const parsed = fromDraft(setting, draft);
  const dirty = draft !== toDraft(setting, setting.value);
  const hint = boundsHint(setting, t);

  // The answer is the setting as the user now sees it: put it in the list.
  const stored = (next: Setting) => {
    queryClient.setQueryData(settingsQuery.queryKey, (old) =>
      old?.map((item) => (item.key === next.key ? next : item)),
    );
    setDraft(toDraft(next, next.value));
  };
  const save = useMutation({
    mutationFn: (value: unknown) =>
      unwrap(
        api.PUT('/v1/settings/{key}/mine', {
          params: { path: { key: setting.key } },
          body: { value },
        }),
      ),
    meta: { errorToast: false },
    onSuccess: (next) => {
      stored(next);
      toast.success(t('preferences.saved'));
    },
  });
  const reset = useMutation({
    mutationFn: () =>
      unwrap(
        api.DELETE('/v1/settings/{key}/mine', {
          params: { path: { key: setting.key } },
        }),
      ),
    meta: { errorToast: false },
    onSuccess: (next) => {
      stored(next);
      toast.success(t('preferences.resetDone'));
    },
  });
  const id = `preference-${setting.key}`;
  const run = async (action: () => Promise<unknown>) => {
    if (staleDraftSession()) return;
    setError(undefined);
    try {
      await action();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };
  return (
    <Section title={setting.label} description={setting.description}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (parsed.ok) {
            void run(() => save.mutateAsync(parsed.value));
          }
        }}
      >
        <FormAlert message={error} />
        <ValueInput
          id={id}
          label={setting.label}
          spec={setting}
          value={draft}
          onChange={setDraft}
          invalid={!parsed.ok}
        />
        {parsed.ok ? (
          hint && <p className="text-sm text-muted-foreground">{hint}</p>
        ) : (
          <p className="text-sm text-destructive">
            {invalidText(parsed.invalid, t)}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <SourceBadge source={setting.source} />
          <span>
            {t('default')}: {formatValue(setting.default, t('on'), t('off'))}
          </span>
        </div>
        <div className="flex gap-2">
          <Button
            type="submit"
            disabled={!dirty || !parsed.ok || save.isPending}
          >
            {save.isPending && <Spinner />}
            {t('save')}
          </Button>
          {setting.source === 'user' && (
            <Button
              type="button"
              variant="outline"
              disabled={reset.isPending}
              onClick={() => void run(() => reset.mutateAsync())}
            >
              {t('preferences.reset')}
            </Button>
          )}
        </div>
      </form>
    </Section>
  );
}
